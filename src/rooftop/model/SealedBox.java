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
 */
public class SealedBox {
    public static final long KEEP_MS = 60 * 60 * 1000; // uncollected sealed files are deleted after an hour

    /** What the recipient learns: an id and a size. The name is inside the sealed bytes. */
    public record Waiting(String id, long size, long at) {
    }

    private record Entry(Set<String> to, long size, long at, Set<String> collected) {
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

    /** Appends a piece of sealed bytes (resumable, like the inbox), for the devices in {@code to}. */
    public void append(String id, Set<String> to, long size, long offset, InputStream in, long count) throws IOException {
        Path p = path(id);
        synchronized (this) {
            Entry e = entries.get(id);
            if (e == null) entries.put(id, new Entry(new HashSet<>(to), size, System.currentTimeMillis(), new HashSet<>()));
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
        if (e.collected().containsAll(e.to())) {
            entries.remove(id);
            Files.deleteIfExists(path(id));
        }
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
