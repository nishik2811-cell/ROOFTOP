package rooftop.net;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import rooftop.Rooftop;
import rooftop.error.RooftopException;
import rooftop.error.TransferFailedException;
import rooftop.error.WrongPinException;
import rooftop.model.Device;
import rooftop.model.PcPeer;
import rooftop.model.Payload;
import rooftop.model.Progress;
import rooftop.model.ReceivedItem;
import rooftop.security.SecureChannel;
import rooftop.util.Streams;
import rooftop.util.Texts;
import rooftop.util.Threads;

/** Receives files and texts from other PCs. Extends Thread; each connection gets its own worker. */
public class TransferServer extends Thread {
    private static final int READ_TIMEOUT_MS = 30_000;

    private final Rooftop app;

    public TransferServer(Rooftop app) {
        super("transfer-server");
        this.app = app;
        setDaemon(true);
    }

    @Override
    public void run() {
        try (ServerSocket server = new ServerSocket(Wire.TCP_PORT)) {
            while (!isInterrupted()) {
                Socket socket = server.accept();
                Threads.daemon("receive-" + socket.getInetAddress().getHostAddress(), () -> handle(socket));
            }
        } catch (IOException e) {
            app.log().add("transfer server stopped: " + e.getMessage());
        }
    }

    /** The one place receive errors stop. Everything below just throws. */
    private void handle(Socket socket) {
        try (socket) {
            socket.setSoTimeout(READ_TIMEOUT_MS);
            receive(SecureChannel.open(socket, false), socket.getInetAddress().getHostAddress());
        } catch (WrongPinException e) {
            app.log().add(e.getMessage());
        } catch (RooftopException | IOException | IllegalArgumentException e) {
            app.log().add("receive failed: " + e.getMessage());
        }
    }

    private void receive(SecureChannel channel, String ip) throws IOException, RooftopException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(channel.input()));
        OutputStream out = channel.output();
        Wire.Header header = Wire.Header.read(in);
        try {
            app.pins().check(ip, header.pin()); // throws WrongPinException...
        } catch (WrongPinException e) {
            out.write(Wire.REJECT);              // ...tell the sender why...
            out.flush();
            throw e;                             // ...and let it propagate up to handle()
        }
        if (header.size() < 0) throw new TransferFailedException("negative size from " + ip);
        out.write(Wire.ACCEPT);
        out.flush();

        String from = app.devices().ofType(PcPeer.class).stream()
                .filter(p -> p.address().getHostAddress().equals(ip))
                .map(Device::name).findFirst().orElse(ip);
        if (Payload.TEXT.equals(header.type())) {
            if (header.size() > Wire.MAX_TEXT) throw new TransferFailedException("text from " + ip + " is too long");
            byte[] bytes = Streams.readFully(in, (int) header.size());
            app.receiveText(new String(bytes, StandardCharsets.UTF_8), from);
        } else {
            receiveFile(header, in, out, ip, from);
            return;
        }
        out.write(Wire.DONE);
        out.flush();
    }

    /** Resumes from whatever arrived last time, then checks the SHA-256 of the whole file before showing it. */
    private void receiveFile(Wire.Header header, DataInputStream in, OutputStream rawOut, String ip, String from)
            throws IOException, RooftopException {
        DataOutputStream out = new DataOutputStream(rawOut);
        long size = header.size();
        String id = Texts.sha256(ip + "|" + header.key()).substring(0, 32);
        long have = app.inbox().received(id);
        if (have > size) {
            app.inbox().discard(id);
            have = 0;
        }
        out.writeLong(have);
        out.flush();
        app.log().add((have > 0 ? "resuming " + header.name() + " at " + Texts.humanSize(have) + " of " : "receiving " + header.name() + " (")
                + Texts.humanSize(size) + (have > 0 ? "" : ")") + " from " + from);

        MessageDigest sha = TransferClient.sha256();
        app.inbox().digestReceived(id, sha);
        long started = System.nanoTime();
        app.inbox().append(id, have, new DigestInputStream(in, sha), size - have, new Progress(size - have));
        byte[] expected = Streams.readFully(in, 32);
        if (!MessageDigest.isEqual(expected, sha.digest())) {
            app.inbox().discard(id);
            out.write(Wire.DAMAGED);
            out.flush();
            throw new TransferFailedException(header.name() + " from " + from + " arrived damaged, discarded");
        }
        ReceivedItem item = app.inbox().finish(id, header.name(), size, from, "", ReceivedItem.EVERYONE);
        out.write(Wire.DONE);
        out.flush();
        app.log().add("saved " + item.name() + " from " + from + " (SHA-256 checked), " + Texts.speed(size - have, System.nanoTime() - started));
    }
}
