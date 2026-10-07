package rooftop.model;

import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

/**
 * Ephemeral signaling relay for direct peer-to-peer WebRTC video/audio calls.
 * Signals (invitations, SDP offer/answer, ICE candidates, hangup) are held in memory
 * only until collected or expired (default 35 seconds). No media bytes ever pass through here.
 */
public class CallBox {
    public static final int MAX_SIGNALS = 2000;
    public static final int TTL_SECONDS = 35;

    public record Signal(long seq, String from, String to, String type, String data, long at, long expires) {
        boolean alive(long now) {
            return now < expires;
        }
    }

    private final LinkedList<Signal> signals = new LinkedList<>();
    private long seq;

    public synchronized long add(String from, String to, String type, String data) {
        long now = System.currentTimeMillis();
        signals.add(new Signal(++seq, from, to, type, data, now, now + TTL_SECONDS * 1000L));
        signals.removeIf(s -> !s.alive(now));
        while (signals.size() > MAX_SIGNALS) signals.removeFirst();
        return seq;
    }

    public synchronized List<Signal> since(long after, String toDevice) {
        long now = System.currentTimeMillis();
        List<Signal> out = new ArrayList<>();
        for (Signal s : signals) {
            boolean match = s.to().equals(toDevice) || "*".equals(s.to())
                    || ("host".equalsIgnoreCase(toDevice) && "host".equalsIgnoreCase(s.to()));
            if (s.seq() > after && match && s.alive(now)) {
                out.add(s);
            }
        }
        return out;
    }

    public synchronized long latest() {
        return seq;
    }

    public synchronized void clear() {
        signals.clear();
    }
}
