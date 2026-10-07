package rooftop.model;

import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

/**
 * Finished and failed transfers, newest first, for the History list. It outlives the files themselves
 * (removing a file keeps its line here) but not the session: a new session starts with a clean history.
 */
public class History {
    private static final int KEEP = 300;

    /**
     * One transfer. fromId and to are device ids as in ReceivedItem; millis is how long the data took (0 if unknown);
     * ratio is the bytes on the wire per byte of file (1 when nothing was compressed).
     */
    public record Entry(long at, String name, long size, String from, String fromId, String to, String toName,
                        boolean ok, long millis, double ratio, String note) {
        public boolean visibleTo(String deviceId) {
            return ReceivedItem.EVERYONE.equals(to) || to.equals(deviceId) || fromId.equals(deviceId);
        }
    }

    private final LinkedList<Entry> entries = new LinkedList<>();

    public synchronized void add(Entry entry) {
        entries.addFirst(entry);
        if (entries.size() > KEEP) entries.removeLast();
    }

    public synchronized List<Entry> newestFirst() {
        return new ArrayList<>(entries);
    }

    public synchronized void clear() {
        entries.clear();
    }
}
