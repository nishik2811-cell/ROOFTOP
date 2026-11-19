package rooftop.error;

import java.io.IOException;

/**
 * The same upload is still arriving on an older connection, usually one that broke on the sender's side and that this
 * end has not noticed yet (it gives up after the read timeout). The sender should wait a little and try again.
 */
public class StillArrivingException extends IOException {
    public StillArrivingException() {
        super("already arriving on another connection");
    }
}
