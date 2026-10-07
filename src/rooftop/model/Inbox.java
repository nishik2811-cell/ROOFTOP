package rooftop.model;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import rooftop.error.InvalidFileNameException;
import rooftop.error.OffsetMismatchException;
import rooftop.security.FileNames;
import rooftop.util.Streams;

/** Aggregation: the inbox holds ReceivedItems, which are plain values that can outlive it. */
public class Inbox {
    private static final int MAX_TEXTS = 20;
    private static final long STALE_PART_MS = 24L * 60 * 60 * 1000; // unfinished transfers are kept this long for resuming

    private final Path dir;
    private final List<ReceivedItem> items = new ArrayList<>();      // insertion order
    private final Set<String> takenNames = new HashSet<>();          // fast "is this name used?"
    private final LinkedList<ReceivedText> texts = new LinkedList<>(); // newest first, capped
    private final Set<String> receiving = new HashSet<>();           // resumable ids being written right now

    public Inbox(Path dir) throws IOException {
        this.dir = dir;
        Files.createDirectories(dir);
        try (Stream<Path> files = Files.list(dir)) {
            for (Path p : (Iterable<Path>) files::iterator) {
                String name = p.getFileName().toString();
                if (name.endsWith(".part") && Files.isRegularFile(p)) { // leftovers: keep recent resumables, drop the rest
                    boolean stale = System.currentTimeMillis() - Files.getLastModifiedTime(p).toMillis() > STALE_PART_MS;
                    if (stale || !name.startsWith(".")) Files.deleteIfExists(p);
                    continue;
                }
                if (!Files.isRegularFile(p) || name.startsWith(".")) continue; // hidden files stay private
                items.add(new ReceivedItem(p.getFileName().toString(), Files.size(p), "earlier", "", ReceivedItem.EVERYONE,
                        Files.getLastModifiedTime(p).toMillis()));
                takenNames.add(p.getFileName().toString());
            }
        }
    }

    public Path dir() {
        return dir;
    }

    /** Streams exactly {@code size} bytes into a new file. A cut-off transfer leaves nothing behind. */
    public ReceivedItem store(String rawName, InputStream in, long size, String from, Progress progress) throws IOException {
        return store(rawName, in, size, from, "", ReceivedItem.EVERYONE, progress);
    }

    /** Same, for a file addressed to one device (to = its id) or to everyone (to = "*"). */
    public ReceivedItem store(String rawName, InputStream in, long size, String from, String fromId, String to, Progress progress)
            throws IOException {
        String name = reserve(rawName);
        Path tmp = dir.resolve(name + ".part");
        try {
            try (OutputStream out = Files.newOutputStream(tmp)) {
                Streams.copy(in, out, size, progress);
            }
            Files.move(tmp, dir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            Files.deleteIfExists(tmp);
            synchronized (this) {
                takenNames.remove(name);
            }
            throw e;
        }
        ReceivedItem item = new ReceivedItem(name, size, from, fromId, to, System.currentTimeMillis());
        synchronized (this) {
            items.add(item);
        }
        return item;
    }

    /* ---- resumable transfers: bytes go into a hidden ".<id>.part" file that survives a dropped connection ---- */

    private Path partial(String id) {
        if (id == null || !id.matches("[0-9a-f]{16,64}")) throw new InvalidFileNameException("bad transfer id");
        return dir.resolve("." + id + ".part");
    }

    /** How many bytes of this transfer already arrived (0 for a new one). */
    public long received(String id) throws IOException {
        Path p = partial(id);
        return Files.exists(p) ? Files.size(p) : 0;
    }

    /** Feeds the bytes already received into a digest, so a final check covers the whole file across resumes. */
    public void digestReceived(String id, MessageDigest digest) throws IOException {
        Path p = partial(id);
        if (!Files.exists(p)) return;
        byte[] buf = new byte[Streams.CHUNK];
        try (InputStream in = new DigestInputStream(Files.newInputStream(p), digest)) {
            while (in.read(buf) > 0) {
                // reading is enough: DigestInputStream updates the digest
            }
        }
    }

    /**
     * Appends {@code count} bytes that start at byte {@code offset} of the file. If the connection drops halfway,
     * what arrived stays on disk and the next try continues from there.
     */
    public void append(String id, long offset, InputStream in, long count, Progress progress) throws IOException {
        Path p = partial(id);
        synchronized (this) {
            if (!receiving.add(id)) throw new IOException("this file is already arriving on another connection");
        }
        try {
            long have = Files.exists(p) ? Files.size(p) : 0;
            if (have != offset) throw new OffsetMismatchException(have);
            try (OutputStream out = Files.newOutputStream(p, StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                Streams.copy(in, out, count, progress);
            }
        } finally {
            synchronized (this) {
                receiving.remove(id);
            }
        }
    }

    /** All bytes are here: give the file its real name and show it. */
    public ReceivedItem finish(String id, String rawName, long size, String from, String fromId, String to) throws IOException {
        Path p = partial(id);
        if (!Files.exists(p) || Files.size(p) != size) throw new IOException("file is incomplete");
        String name = reserve(rawName);
        try {
            Files.move(p, dir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            synchronized (this) {
                takenNames.remove(name);
            }
            throw e;
        }
        ReceivedItem item = new ReceivedItem(name, size, from, fromId, to, System.currentTimeMillis());
        synchronized (this) {
            items.add(item);
        }
        return item;
    }

    /** Throws away an unfinished transfer, e.g. when its bytes turned out to be damaged. */
    public void discard(String id) throws IOException {
        Files.deleteIfExists(partial(id));
    }

    /** Picks a free name: "photo.jpg", then "photo (2).jpg", and so on. */
    private synchronized String reserve(String rawName) {
        String clean = FileNames.clean(rawName);
        String name = clean;
        for (int i = 2; takenNames.contains(name) || Files.exists(dir.resolve(name)); i++)
            name = FileNames.withSuffix(clean, " (" + i + ")");
        takenNames.add(name);
        return name;
    }

    public Path pathOf(String rawName) throws NoSuchFileException {
        Path p = dir.resolve(FileNames.clean(rawName));
        if (!Files.isRegularFile(p)) throw new NoSuchFileException(rawName);
        return p;
    }

    public synchronized List<ReceivedItem> newestFirst() {
        prune();
        List<ReceivedItem> copy = new ArrayList<>(items);
        copy.sort(Comparator.comparingLong(ReceivedItem::at).reversed());
        return copy;
    }

    public synchronized TreeSet<ReceivedItem> byName() {
        prune();
        TreeSet<ReceivedItem> sorted = new TreeSet<>(
                Comparator.comparing(ReceivedItem::name, String.CASE_INSENSITIVE_ORDER).thenComparing(ReceivedItem::name));
        sorted.addAll(items);
        return sorted;
    }

    public synchronized boolean remove(String rawName) throws IOException {
        String name = FileNames.clean(rawName);
        boolean found = false;
        for (Iterator<ReceivedItem> it = items.iterator(); it.hasNext(); ) {
            if (it.next().name().equals(name)) {
                it.remove();
                found = true;
            }
        }
        takenNames.remove(name);
        return Files.deleteIfExists(dir.resolve(name)) || found;
    }

    /** Forget files someone deleted from the folder by hand. */
    private void prune() {
        items.removeIf(i -> !Files.exists(dir.resolve(i.name())));
    }

    public synchronized void addText(String text, String from) {
        texts.addFirst(new ReceivedText(text, from, System.currentTimeMillis()));
        if (texts.size() > MAX_TEXTS) texts.removeLast();
    }

    /** A new session starts empty: messages cleared, and every file this inbox received is deleted. Returns how many. */
    public synchronized int newSession() throws IOException {
        texts.clear();
        int removed = 0;
        for (ReceivedItem i : new ArrayList<>(items))
            if (remove(i.name())) removed++;
        try (Stream<Path> files = Files.list(dir)) { // and any half-received files
            for (Path p : (Iterable<Path>) files::iterator) {
                String name = p.getFileName().toString();
                if (name.startsWith(".") && name.endsWith(".part") && !receiving.contains(name.substring(1, name.length() - 5)))
                    Files.deleteIfExists(p);
            }
        }
        return removed;
    }

    public synchronized List<ReceivedText> texts() {
        return new ArrayList<>(texts);
    }
}
