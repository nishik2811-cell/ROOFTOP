package rooftop.model;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import rooftop.security.FileNames;
import rooftop.util.Streams;

/** Aggregation: the inbox holds ReceivedItems, which are plain values that can outlive it. */
public class Inbox {
    private static final int MAX_TEXTS = 20;

    private final Path dir;
    private final List<ReceivedItem> items = new ArrayList<>();      // insertion order
    private final Set<String> takenNames = new HashSet<>();          // fast "is this name used?"
    private final LinkedList<ReceivedText> texts = new LinkedList<>(); // newest first, capped

    public Inbox(Path dir) throws IOException {
        this.dir = dir;
        Files.createDirectories(dir);
        try (Stream<Path> files = Files.list(dir)) {
            for (Path p : (Iterable<Path>) files::iterator) {
                String name = p.getFileName().toString();
                if (!Files.isRegularFile(p) || name.endsWith(".part") || name.startsWith(".")) continue; // hidden files stay private
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

    /**
     * A new session: messages are cleared, and files from before stay on this device (never deleted)
     * but are no longer shown to phones.
     */
    public synchronized void newSession() {
        texts.clear();
        items.replaceAll(i -> new ReceivedItem(i.name(), i.size(), i.from(), "", ThisDevice.ID, i.at()));
    }

    public synchronized List<ReceivedText> texts() {
        return new ArrayList<>(texts);
    }
}
