package rooftop.net;

import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import rooftop.error.RooftopException;
import rooftop.error.TransferFailedException;
import rooftop.model.Payload;
import rooftop.model.Transfer;
import rooftop.security.SecureChannel;
import rooftop.util.Streams;

public final class TransferClient {
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 30_000;

    private TransferClient() {
    }

    public static void send(Transfer transfer) throws IOException, RooftopException {
        Payload payload = transfer.payload();
        String who = transfer.target().name();
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(transfer.target().address(), Wire.TCP_PORT), CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(READ_TIMEOUT_MS);
            SecureChannel channel = SecureChannel.open(socket, true);
            DataOutputStream out = new DataOutputStream(channel.output());
            InputStream in = channel.input();

            new Wire.Header(payload.wireType(), transfer.pin(), payload.name(), payload.size()).write(out);
            out.flush();
            int reply = in.read();
            if (reply == Wire.REJECT) throw new TransferFailedException(who + " says the PIN is wrong");
            if (reply != Wire.ACCEPT) throw new TransferFailedException(who + " hung up");

            long started = System.nanoTime();
            try (InputStream source = payload.open()) {
                Streams.copy(source, out, payload.size(), transfer.progress());
            }
            out.flush();
            if (in.read() != Wire.DONE) throw new TransferFailedException(who + " did not confirm it saved the file");
            transfer.finished(System.nanoTime() - started);
        }
    }
}
