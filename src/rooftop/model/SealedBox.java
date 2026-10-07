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
 * End-to-end encrypted files waiting for their one recipient. The sender's browser sealed them with the
 * recipient's key, so this PC only ever holds bytes it cannot read. Kept out of the Inbox on purpose: nothing here
 * shows up in the city, the inbox, the log or the terminal, and only the minimum is remembered
 * (recipient id, size, when it arrived), in memory only.
 */
public class SealedBox {
    public static final long KEEP_MS = 60 * 60 * 1000; // uncollected sealed files are deleted after an hour

    /** What the recipient learns: an id and a size. The name is inside the sealed bytes. */
    public record Waiting(String id, long size, long at) {
    }

    private record Entry(String to, long size, long at) {
    }

    private final Path dir;
    private final Map<String, Entry> entries = new HashMap<>();
    private final Set<String> busy = new HashSet<>();

    public SealedBox(Path dir) throws IOException {
        this.dir = dir;
        Files.createDirectories(dir);
        if (FileSystems.getDefault().supportedFileAttributeViews().contains("posix"))
            Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------")); // only this user
        wipeFolder(); // nothing survives a restart: its metadata is gone, so nobody could collect it
    }

    public Path dir() {
        return dir;
    }

    private Path path(String id) {
        if (id == null || !id.matches("[0-9a-f]{32}")) throw new InvalidFileNameException("bad sealed id");
        return dir.resolve(id);
    }

    /** Appends a piece of sealed bytes (resumable, like the inbox). */
    public void append(String id, String to, long size, long offset, InputStream in, long count) throws IOException {
        Path p = path(id);
        synchronized (this) {
            Entry e = entries.get(id);
            if (e == null) entries.put(id, new Entry(to, size, System.currentTimeMillis()));
            else if (!e.to().equals(to) || e.size() != size) throw new IOException("this upload belongs to another transfer");
            if (!busy.add(id)) throw new IOException("already arriving on another connection");
        }
        try {
            long have = Files.exists(p) ? Files.size(p) : 0;
            if (have != offset) throw new OffsetMismatchException(have);
            try (OutputStream out = Files.newOutputStream(p, StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                Streams.copy(in, out, count, new Progress(count));
            }
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
            Path p = dir.resolve(e.getKey());
            if (e.getValue().to().equals(deviceId) && Files.exists(p) && Files.size(p) == e.getValue().size())
                out.add(new Waiting(e.getKey(), e.getValue().size(), e.getValue().at()));
        }
        return out;
    }

    /** The sealed file, for its recipient only. */
    public synchronized Path collect(String id, String deviceId) throws IOException {
        Entry e = entries.get(id);
        Path p = path(id);
        if (e == null || !e.to().equals(deviceId) || !Files.exists(p) || Files.size(p) != e.size()) throw new NoSuchFileException("sealed");
        return p;
    }

    /** The recipient saved it: delete the bytes and forget it ever existed. */
    public synchronized boolean acknowledge(String id, String deviceId) throws IOException {
        Entry e = entries.get(id);
        if (e == null || !e.to().equals(deviceId)) return false;
        entries.remove(id);
        Files.deleteIfExists(path(id));
        return true;
    }

    /** Deletes sealed files nobody collected within {@link #KEEP_MS}. */
    public synchronized void sweep() throws IOException {
        long now = System.currentTimeMillis();
        for (var it = entries.entrySet().iterator(); it.hasNext(); ) {
            var e = it.next();
            if (now - e.getValue().at() > KEEP_MS && !busy.contains(e.getKey())) {
                Files.deleteIfExists(dir.resolve(e.getKey()));
                it.remove();
            }
        }
    }

    /** Session over: everything goes. */
    public synchronized void clear() throws IOException {
        entries.clear();
        wipeFolder();
    }

    /** For the check: how many sealed transfers are known (files on disk are counted separately). */
    public synchronized int count() {
        return entries.size();
    }

    private void wipeFolder() throws IOException {
        try (Stream<Path> files = Files.list(dir)) {
            for (Path p : (Iterable<Path>) files::iterator)
                if (!busy.contains(p.getFileName().toString())) Files.deleteIfExists(p);
        }
    }
}
