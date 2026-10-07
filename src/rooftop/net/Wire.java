package rooftop.net;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/** Ports and the little protocol PCs speak to each other (inside a SecureChannel). */
public final class Wire {
    public static final int UDP_PORT = 45454;
    public static final int TCP_PORT = 45455;
    public static final int HTTPS_PORT = 8443;
    public static final int LOCAL_PORT = 8080;
    public static final String BEACON = "ROOFTOP ";
    /** Sent next to BEACON by PCs that understand compressed transfers. Older ones ignore it: it does not start with BEACON. */
    public static final String BEACON_FRAMES = "ROOFTOP+FRAMES ";
    /** Header type of a file sent in {@link Frames}, used only towards PCs that announced BEACON_FRAMES. */
    public static final String FILE_FRAMED = "FILE+FRAMES";
    public static final int ACCEPT = 'Y';
    public static final int REJECT = 'N';
    public static final int DONE = 'D';
    public static final int DAMAGED = 'X'; // the file's SHA-256 did not match: the receiver threw it away
    public static final int MAX_TEXT = 1 << 20;

    private Wire() {
    }

    /**
     * First thing sent on every transfer. {@code key} names the file on the sender's side (name, size, last change),
     * so a second try of the same file can resume where the first one stopped.
     *
     * <p>File transfer: header, then Y + the 8-byte offset to resume from (or N), then the bytes from that offset,
     * then the 32-byte SHA-256 of the whole file, then D (saved) or X (damaged, discarded).
     * With type FILE_FRAMED the bytes from the offset travel as {@link Frames}; everything else is the same.
     */
    public record Header(String type, String pin, String name, long size, String key) {
        public void write(DataOutputStream out) throws IOException {
            out.writeUTF(type);
            out.writeUTF(pin);
            out.writeUTF(name);
            out.writeLong(size);
            out.writeUTF(key);
        }

        public static Header read(DataInputStream in) throws IOException {
            return new Header(in.readUTF(), in.readUTF(), in.readUTF(), in.readLong(), in.readUTF());
        }
    }
}
