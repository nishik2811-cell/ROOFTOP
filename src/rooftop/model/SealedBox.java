package rooftop.model;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import rooftop.error.InvalidFileNameException;
import rooftop.error.OffsetMismatchException;
import rooftop.util.Streams;

/**
 * End-to-end encrypted files waiting for their recipients. The sender's browser sealed each one with a fresh file key
 * wrapped for every recipient, so this PC only ever holds bytes it cannot read (wrapped keys included). Kept out of
 * the Inbox on purpose: nothing here shows up in the city, the inbox, the history, the log or the terminal, and only
 * the minimum is remembered, in memory only: the transfer id, the recipient ids, the padded size, and when it
 * arrived (for the one-hour limit). Once every recipient has acknowledged, the bytes and that record are deleted.
 *
 * <p>Files addressed to this PC (directly or via Everyone) are held like a message app holds a message until you
 * open it: they sit in a hidden folder next to the inbox, survive restarts and session ends, and are never deleted
 * until this PC's own page has decrypted and acknowledged them. Only other devices' claims expire.
 */
public class SealedBox {
    public static final long KEEP_MS = 60 * 60 * 1000; // uncollected sealed files are deleted after an hour

    /** What the recipient learns: an id and a size. The name is inside the sealed bytes. */
    public record Waiting(String id, long size, long at) {
    }

    private record Entry(Set<String> to, long size, long at, Set<String> collected) {
    }

    private final Path dir;
    private final Path held;
    private final String hostId;
    private final Map<String, Entry> entries = new HashMap<>();
    private final Set<String> busy = new HashSet<>();

    /** {@code dir}: temp folder for other devices' files. {@code held}: hidden folder for files waiting for this PC. */
    public SealedBox(Path dir, Path held, String hostId) throws IOException {
        this.dir = dir;
        this.held = held;
        this.hostId = hostId;
        for (Path d : new Path[]{dir, held}) {
            Files.createDirectories(d);
            if (FileSystems.getDefault().supportedFileAttributeViews().contains("posix"))
                Files.setPosixFilePermissions(d, PosixFilePermissions.fromString("rwx------")); // only this user
        }
        wipeFolder(); // other devices' files do not survive a restart: their metadata is gone, nobody could collect them
        loadHeld();   // files for this PC do
    }

    public Path dir() {
        return dir;
    }

    private static String check(String id) {
        if (id == null || !id.matches("[0-9a-f]{32}")) throw new InvalidFileNameException("bad sealed id");
        return id;
    }

    private Path path(String id) {
        Entry e = entries.get(check(id));
        return (e != null && e.to().contains(hostId) ? held : dir).resolve(id);
    }

    /** Appends a piece of sealed bytes (resumable, like the inbox), for the devices in {@code to}. */
    public void append(String id, Set<String> to, long size, long offset, InputStream in, long count) throws IOException {
        Path p;
        synchronized (this) {
            Entry e = entries.get(check(id));
            if (e == null) entries.put(id, new Entry(new HashSet<>(to), size, System.currentTimeMillis(), new HashSet<>()));
            else if (!e.to().containsAll(to) || e.size() != size) throw new IOException("this upload belongs to another transfer");
            if (!busy.add(id)) throw new IOException("already arriving on another connection");
            p = path(id);
        }
        try {
            long have = Files.exists(p) ? Files.size(p) : 0;
            if (have != offset) throw new OffsetMismatchException(have);
            try (OutputStream out = Files.newOutputStream(p, StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                Streams.copy(in, out, count, new Progress(count));
            }
            if (offset + count == size && to.contains(hostId)) // complete, and this PC is a recipient: write it down
                Files.write(held.resolve(id + ".meta"), (size + "\n" + entries.get(id).at() + "\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        } finally {
            synchronized (this) {
                busy.remove(id);
            }
        }
    }

    /** Complete sealed files addressed to this device. */
    public synchronized List<Waiting> waitingFor(String deviceId) throws IOException {
        sweep();
        List<Waiting> out = new ArrayList<>();
        for (Map.Entry<String, Entry> e : entries.entrySet()) {
            Path p = path(e.getKey());
            Entry v = e.getValue();
            if (v.to().contains(deviceId) && !v.collected().contains(deviceId) && Files.exists(p) && Files.size(p) == v.size())
                out.add(new Waiting(e.getKey(), e.getValue().size(), e.getValue().at()));
        }
        return out;
    }

    /** The sealed file, for its recipient only. */
    public synchronized Path collect(String id, String deviceId) throws IOException {
        Entry e = entries.get(id);
        Path p = path(id);
        if (e == null || !e.to().contains(deviceId) || e.collected().contains(deviceId) || !Files.exists(p) || Files.size(p) != e.size())
            throw new NoSuchFileException("sealed");
        return p;
    }

    /** A recipient saved its copy. After the last one, delete the bytes and forget the transfer ever existed. */
    public synchronized boolean acknowledge(String id, String deviceId) throws IOException {
        Entry e = entries.get(id);
        if (e == null || !e.to().contains(deviceId) || !e.collected().add(deviceId)) return false;
        if (deviceId.equals(hostId)) Files.deleteIfExists(held.resolve(id + ".meta"));
        if (e.collected().containsAll(e.to())) forget(id);
        return true;
    }

    private void forget(String id) throws IOException {
        Path p = path(id);
        entries.remove(id);
        Files.deleteIfExists(p);
        Files.deleteIfExists(held.resolve(id + ".meta"));
    }

    /** After {@link #KEEP_MS}, other devices lose their claim. A file still waiting for this PC is never deleted. */
    public synchronized void sweep() throws IOException {
        expire(System.currentTimeMillis() - KEEP_MS);
    }

    /** Session over: phones are gone, so their claims go. Files still waiting for this PC stay. */
    public synchronized void clear() throws IOException {
        expire(Long.MAX_VALUE);
    }

    private void expire(long arrivedBefore) throws IOException {
        for (String id : new ArrayList<>(entries.keySet())) {
            Entry e = entries.get(id);
            if (e.at() >= arrivedBefore || busy.contains(id)) continue;
            Path p = path(id);
            boolean complete = Files.exists(p) && Files.size(p) == e.size();
            boolean forPc = e.to().contains(hostId) && !e.collected().contains(hostId);
            if (complete && forPc) e.to().removeIf(r -> !r.equals(hostId) && !e.collected().contains(r));
            else forget(id);
        }
    }

    /** For the check: how many sealed transfers are known (files on disk are counted separately). */
    public synchronized int count() {
        return entries.size();
    }

    /** After a restart: files that were waiting for this PC come back; half-uploaded ones are dropped. */
    private void loadHeld() throws IOException {
        try (Stream<Path> files = Files.list(held)) {
            for (Path p : (Iterable<Path>) files::iterator) {
                String name = p.getFileName().toString();
                if (name.endsWith(".meta")) continue;
                Path meta = held.resolve(name + ".meta");
                if (!name.matches("[0-9a-f]{32}") || !Files.exists(meta)) {
                    Files.deleteIfExists(p);
                    continue;
                }
                String[] f = new String(Files.readAllBytes(meta), java.nio.charset.StandardCharsets.US_ASCII).split("\n");
                Set<String> to = new HashSet<>(Set.of(hostId));
                entries.put(name, new Entry(to, Long.parseLong(f[0].trim()), Long.parseLong(f[1].trim()), new HashSet<>()));
            }
        }
    }

    private void wipeFolder() throws IOException {
        try (Stream<Path> files = Files.list(dir)) {
            for (Path p : (Iterable<Path>) files::iterator)
                if (!busy.contains(p.getFileName().toString())) Files.deleteIfExists(p);
        }
    }
}
