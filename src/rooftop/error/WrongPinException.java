package rooftop.error;

/** Checked: thrown deep inside PinGuard and propagated up to whoever owns the connection. */
public class WrongPinException extends RooftopException {
    private final boolean blocked;

    public WrongPinException(String ip, boolean blocked) {
        super("wrong PIN from " + ip + (blocked ? " (blocked until restart)" : ""));
        this.blocked = blocked;
    }

    public boolean isBlocked() {
        return blocked;
    }
}
