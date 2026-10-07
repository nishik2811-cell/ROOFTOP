package rooftop.error;

import java.io.IOException;

/** A resumed transfer started at the wrong place. Carries where it should start, so the sender can jump there. */
public class OffsetMismatchException extends IOException {
    private final long expected;

    public OffsetMismatchException(long expected) {
        super("resume should start at byte " + expected);
        this.expected = expected;
    }

    public long expected() {
        return expected;
    }
}
