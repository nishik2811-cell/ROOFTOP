package rooftop.error;

import java.io.IOException;

/** The PC-to-PC handshake failed: the two sides do not share the PIN, or someone is sitting in between. */
public class PinMismatchException extends IOException {
    public PinMismatchException() {
        super("the PIN does not match (or someone is in the middle), nothing was sent");
    }
}
