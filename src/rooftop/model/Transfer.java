package rooftop.model;

/** One queued send. */
public class Transfer {
    private final NetworkDevice target; // the device outlives this transfer
    private final Payload payload;
    private final String pin;
    private final Progress progress;    // created with this transfer and never shared
    private final long queuedAt;

    public Transfer(NetworkDevice target, Payload payload, String pin) {
        this(target, payload, pin, System.currentTimeMillis());
    }

    private Transfer(NetworkDevice target, Payload payload, String pin, long queuedAt) {
        this.target = target;
        this.payload = payload;
        this.pin = pin;
        this.progress = new Progress(payload.size());
        this.queuedAt = queuedAt;
    }

    /** When it was first queued; retries keep the original time. */
    public long queuedAt() {
        return queuedAt;
    }

    public NetworkDevice target() {
        return target;
    }

    public Payload payload() {
        return payload;
    }

    public String pin() {
        return pin;
    }

    public Progress progress() {
        return progress;
    }

    /** A fresh attempt of the same send, with its own progress. */
    public Transfer retry() {
        return new Transfer(target, payload, pin, queuedAt);
    }

    private volatile long nanos = -1;
    private volatile double wireRatio = 1;

    /** Bytes on the wire per byte of payload, set when the transfer was compressed. */
    public void setWireRatio(double ratio) {
        wireRatio = ratio;
    }

    public double wireRatio() {
        return wireRatio;
    }

    public long millis() {
        return nanos < 0 ? 0 : nanos / 1_000_000;
    }

    /** Called once the receiver confirmed: the measured wall-clock time of the data transfer. */
    public void finished(long elapsedNanos) {
        nanos = elapsedNanos;
    }

    public String speed() {
        return nanos < 0 ? "" : rooftop.util.Texts.speed(payload.size(), nanos) + " in " + String.format(java.util.Locale.ROOT, "%.2f s", nanos / 1e9);
    }
}
