package rooftop.error;

/** Checked: thrown deep inside PinGuard and propagated up to whoever owns the connection. */
public class WrongPinException extends RooftopException {
    private final boolean blocked;
    private final boolean busy;

    public WrongPinException(String ip, boolean blocked) {
        this(ip, blocked, false);
    }

    /** {@code busy}: not checked at all, because too many wrong PINs came from the network in the last minute. */
    public WrongPinException(String ip, boolean blocked, boolean busy) {
        super("wrong PIN from " + ip + (blocked ? " (blocked until restart)" : busy ? " (too many guesses on the network)" : ""));
        this.blocked = blocked;
        this.busy = busy;
    }

    public boolean isBusy() {
        return busy;
    }

    public boolean isBlocked() {
        return blocked;
    }
}
