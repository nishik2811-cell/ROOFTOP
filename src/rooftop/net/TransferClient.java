package rooftop.net;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import rooftop.error.RooftopException;
import rooftop.error.TransferFailedException;
import rooftop.model.Payload;
import rooftop.model.Progress;
import rooftop.model.Transfer;
import rooftop.security.SecureChannel;
import rooftop.util.Streams;

public final class TransferClient {
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final OutputStream DISCARD = new OutputStream() { // OutputStream.nullOutputStream() needs Android 13
        @Override
        public void write(int b) {
        }

        @Override
        public void write(byte[] b, int off, int len) {
        }
    };

    private TransferClient() {
    }

    /**
     * One attempt. IOException means the network failed (worth retrying, and the next try resumes);
     * RooftopException means the other side said no (retrying will not help).
     */
    public static void send(Transfer transfer) throws IOException, RooftopException {
        Payload payload = transfer.payload();
        String who = transfer.target().name();
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(transfer.target().address(), Wire.TCP_PORT), CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(READ_TIMEOUT_MS);
            SecureChannel channel = SecureChannel.open(socket, true);
            DataOutputStream out = new DataOutputStream(channel.output());
            DataInputStream in = new DataInputStream(channel.input());

            new Wire.Header(payload.wireType(), transfer.pin(), payload.name(), payload.size(), payload.resumeKey()).write(out);
            out.flush();
            int reply = in.read();
            if (reply == Wire.REJECT) throw new TransferFailedException(who + " says the PIN is wrong");
            if (reply != Wire.ACCEPT) throw new TransferFailedException(who + " hung up");

            long started = System.nanoTime();
            if (Payload.TEXT.equals(payload.wireType())) {
                try (InputStream source = payload.open()) {
                    Streams.copy(source, out, payload.size(), transfer.progress());
                }
            } else {
                long offset = in.readLong();
                if (offset < 0 || offset > payload.size()) throw new TransferFailedException(who + " asked for a strange resume point");
                MessageDigest sha = sha256();
                try (InputStream source = new DigestInputStream(payload.open(), sha)) {
                    Streams.copy(source, DISCARD, offset, new Progress(offset)); // already there: only hash it
                    transfer.progress().add(offset);
                    Streams.copy(source, out, payload.size() - offset, transfer.progress());
                }
                out.write(sha.digest());
            }
            out.flush();
            int result = in.read();
            if (result == Wire.DAMAGED) throw new IOException("the file arrived damaged");
            if (result != Wire.DONE) throw new IOException(who + " did not confirm it saved the file");
            transfer.finished(System.nanoTime() - started);
        }
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("every Java has SHA-256", e);
        }
    }
}
