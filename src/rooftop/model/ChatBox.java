package rooftop.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;

/**
 * Chat relay. Every message, typing signal and group change arrives sealed by the sender's browser for each recipient,
 * so this PC holds only ciphertext and wrapped keys it cannot open, in memory, for the session. Per envelope it knows
 * only: a number, the sender's id, the recipient ids, the (padded) size, when it came, and when it expires (typing
 * signals expire after a few seconds; everything else lasts the session). Nothing here is ever logged or shown.
 */
public class ChatBox {
    public static final int MAX_BYTES = 64 * 1024;
    private static final int KEEP = 5000;

    /** One sealed envelope. {@code expires} is 0 for "until the session ends". */
    public record Envelope(long seq, String from, Set<String> to, byte[] bytes, long at, long expires) {
        boolean alive(long now) {
            return expires == 0 || now < expires;
        }
    }

    private final LinkedList<Envelope> envelopes = new LinkedList<>();
    private long seq;

    public synchronized long add(String from, Set<String> to, byte[] bytes, int ttlSeconds) {
        long now = System.currentTimeMillis();
        envelopes.add(new Envelope(++seq, from, Collections.unmodifiableSet(to), bytes, now, ttlSeconds > 0 ? now + ttlSeconds * 1000L : 0));
        envelopes.removeIf(e -> !e.alive(now));
        while (envelopes.size() > KEEP) envelopes.removeFirst();
        return seq;
    }

    /** Envelopes for this device after {@code after}, oldest first. */
    public synchronized List<Envelope> since(long after, String deviceId) {
        long now = System.currentTimeMillis();
        List<Envelope> out = new ArrayList<>();
        for (Envelope e : envelopes) if (e.seq() > after && e.to().contains(deviceId) && e.alive(now)) out.add(e);
        return out;
    }

    public synchronized long latest() {
        return seq;
    }

    /** For the checks. */
    public synchronized List<Envelope> all() {
        return new ArrayList<>(envelopes);
    }

    /** Session over: every conversation, group and message goes. */
    public synchronized void clear() {
        envelopes.clear();
    }
}
