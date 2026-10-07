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
    public static final int ACCEPT = 'Y';
    public static final int REJECT = 'N';
    public static final int DONE = 'D';
    public static final int MAX_TEXT = 1 << 20;

    private Wire() {
    }

    /** First thing sent on every transfer. */
    public record Header(String type, String pin, String name, long size) {
        public void write(DataOutputStream out) throws IOException {
            out.writeUTF(type);
            out.writeUTF(pin);
            out.writeUTF(name);
            out.writeLong(size);
        }

        public static Header read(DataInputStream in) throws IOException {
            return new Header(in.readUTF(), in.readUTF(), in.readUTF(), in.readLong());
        }
    }
}
