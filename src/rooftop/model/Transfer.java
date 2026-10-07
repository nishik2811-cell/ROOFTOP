package rooftop.model;

/** One queued send. */
public class Transfer {
    private final NetworkDevice target; // the device outlives this transfer
    private final Payload payload;
    private final String pin;
    private final Progress progress;    // created with this transfer and never shared

    public Transfer(NetworkDevice target, Payload payload, String pin) {
        this.target = target;
        this.payload = payload;
        this.pin = pin;
        this.progress = new Progress(payload.size());
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
        return new Transfer(target, payload, pin);
    }

    private volatile long nanos = -1;

    /** Called once the receiver confirmed: the measured wall-clock time of the data transfer. */
    public void finished(long elapsedNanos) {
        nanos = elapsedNanos;
    }

    public String speed() {
        return nanos < 0 ? "" : rooftop.util.Texts.speed(payload.size(), nanos) + " in " + String.format(java.util.Locale.ROOT, "%.2f s", nanos / 1e9);
    }
}
