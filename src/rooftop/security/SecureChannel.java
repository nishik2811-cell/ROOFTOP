package rooftop.security;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import rooftop.error.PinMismatchException;
import rooftop.util.Streams;

/**
 * Encrypted pipe over a TCP socket, used for every PC-to-PC transfer.
 *
 * Handshake: each side sends a fresh elliptic-curve (P-256) public key and a SPAKE2 share made from the receiver's
 * PIN. The keys come from both shared secrets and the whole transcript, and each side then proves it got the same
 * keys. A wrong PIN, or a man in the middle swapping keys, fails right there, before any data moves, and costs the
 * attacker one of the few guesses PinGuard allows. Both sides can show the same short safety code.
 * After that every 64 KB chunk travels as its own encrypted, authenticated frame, so someone sniffing the Wi-Fi
 * sees noise, and a single flipped bit makes the receiver stop instead of saving a corrupted file.
 */
public final class SecureChannel implements Closeable {
    private static final int TAG_BITS = 128;
    private static final int MAX_FRAME = Streams.MAX_CHUNK + 64;
    private static final int MAX_KEY = 256;

    private final Socket socket;
    private final DataInputStream rawIn;
    private final DataOutputStream rawOut;
    private final SecretKey sendKey;
    private final SecretKey receiveKey;
    private final String safetyCode;
    private long sendCounter;
    private long receiveCounter;
    private final InputStream input = new FrameInputStream();
    private final OutputStream output;

    private SecureChannel(Socket socket, boolean initiator, String pin, int frameSize) throws IOException, GeneralSecurityException {
        this.socket = socket;
        this.output = new FrameOutputStream(Math.min(frameSize, Streams.MAX_CHUNK));
        this.rawIn = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
        this.rawOut = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream()));

        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair mine = generator.generateKeyPair();
        byte[] myKey = mine.getPublic().getEncoded();
        Spake2 pake = new Spake2(initiator, pin);
        byte[] myShare = pake.share();
        rawOut.write(MAGIC);
        rawOut.writeShort(myKey.length);
        rawOut.write(myKey);
        rawOut.write(myShare);
        rawOut.flush();

        byte[] magic = Streams.readFully(rawIn, MAGIC.length);
        if (!MessageDigest.isEqual(magic, MAGIC)) throw new IOException("the other PC runs an older Rooftop; update both");
        int length = rawIn.readUnsignedShort();
        if (length > MAX_KEY) throw new IOException("handshake key too large");
        byte[] theirKey = Streams.readFully(rawIn, length);
        byte[] theirShare = Streams.readFully(rawIn, 65);
        PublicKey theirs = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(theirKey));

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(mine.getPrivate());
        agreement.doPhase(theirs, true);
        byte[] secret = agreement.generateSecret();
        byte[] pinSecret = pake.finish(theirShare);

        // everything both sides sent, in a fixed order, so changing any of it changes every key below
        MessageDigest transcript = MessageDigest.getInstance("SHA-256");
        transcript.update(MAGIC);
        for (byte[] part : initiator ? new byte[][]{myKey, theirKey, myShare, theirShare} : new byte[][]{theirKey, myKey, theirShare, myShare}) {
            transcript.update(new byte[]{(byte) (part.length >> 8), (byte) part.length});
            transcript.update(part);
        }
        byte[] master = hmac(transcript.digest(), secret, pinSecret);

        rawOut.write(hmac(master, label(initiator ? "client confirm" : "server confirm")));
        rawOut.flush();
        byte[] theirConfirm = Streams.readFully(rawIn, 32);
        if (!MessageDigest.isEqual(theirConfirm, hmac(master, label(initiator ? "server confirm" : "client confirm"))))
            throw new PinMismatchException();

        SecretKey toServer = new SecretKeySpec(hmac(master, label("client to server")), "AES");
        SecretKey toClient = new SecretKeySpec(hmac(master, label("server to client")), "AES");
        this.sendKey = initiator ? toServer : toClient;
        this.receiveKey = initiator ? toClient : toServer;
        byte[] code = hmac(master, label("safety code"));
        String digits = String.format(java.util.Locale.ROOT, "%06d", ((code[0] & 0xFFL) << 24 | (code[1] & 0xFF) << 16 | (code[2] & 0xFF) << 8 | (code[3] & 0xFF)) % 1_000_000);
        this.safetyCode = digits.substring(0, 3) + " " + digits.substring(3);
    }

    private static final byte[] MAGIC = "RTSC3".getBytes(StandardCharsets.US_ASCII);

    private static byte[] label(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] hmac(byte[] key, byte[]... parts) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) mac.update(p);
        return mac.doFinal();
    }

    /** Six digits, the same on both PCs only if nobody is in between. */
    public String safetyCode() {
        return safetyCode;
    }

    /**
     * Runs the key exchange. {@code initiator} is true on the side that opened the connection; {@code pin} is the
     * receiving PC's PIN (the sender types it, the receiver uses its own). Throws PinMismatchException if they differ.
     */
    public static SecureChannel open(Socket socket, boolean initiator, String pin) throws IOException {
        return open(socket, initiator, pin, Streams.CHUNK);
    }

    /** Same, with an explicit frame size (the benchmark compares 64 KB to 1 MB). */
    public static SecureChannel open(Socket socket, boolean initiator, String pin, int frameSize) throws IOException {
        try {
            return new SecureChannel(socket, initiator, pin, frameSize);
        } catch (GeneralSecurityException e) {
            throw new IOException("encryption handshake failed: " + e.getMessage(), e);
        }
    }

    /** A counter nonce never repeats because every connection gets brand new keys. */
    private static GCMParameterSpec nonce(long counter) {
        return new GCMParameterSpec(TAG_BITS, ByteBuffer.allocate(12).putLong(4, counter).array());
    }

    public InputStream input() {
        return input;
    }

    public OutputStream output() {
        return output;
    }

    private synchronized void sendFrame(byte[] plain, int offset, int length) throws IOException {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, sendKey, nonce(sendCounter++));
            byte[] sealed = cipher.doFinal(plain, offset, length);
            rawOut.writeInt(sealed.length);
            rawOut.write(sealed);
            rawOut.flush();
        } catch (GeneralSecurityException e) {
            throw new IOException("encrypt failed: " + e.getMessage(), e);
        }
    }

    private byte[] receiveFrame() throws IOException {
        int length = rawIn.readInt();
        if (length < TAG_BITS / 8 || length > MAX_FRAME) throw new IOException("bad frame length " + length);
        byte[] sealed = Streams.readFully(rawIn, length);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, receiveKey, nonce(receiveCounter++));
            return cipher.doFinal(sealed);
        } catch (AEADBadTagException e) {
            throw new IOException("data was tampered with or corrupted on the way");
        } catch (GeneralSecurityException e) {
            throw new IOException("decrypt failed: " + e.getMessage(), e);
        }
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }

    /** Inner class: hands out decrypted bytes, pulling the next frame when the current one runs dry. */
    private final class FrameInputStream extends InputStream {
        private byte[] frame = new byte[0];
        private int pos;

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) == -1 ? -1 : one[0] & 0xFF;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            while (pos == frame.length) {
                try {
                    frame = receiveFrame();
                    pos = 0;
                } catch (EOFException e) {
                    return -1;
                }
            }
            int n = Math.min(len, frame.length - pos);
            System.arraycopy(frame, pos, b, off, n);
            pos += n;
            return n;
        }
    }

    /** Inner class: collects writes into 64 KB chunks and seals each chunk as one frame. */
    private final class FrameOutputStream extends OutputStream {
        private final byte[] buffer; // reused for every frame: no allocation in the hot path
        private int count;

        FrameOutputStream(int size) {
            buffer = new byte[size];
        }

        @Override
        public void write(int b) throws IOException {
            if (count == buffer.length) flush();
            buffer[count++] = (byte) b;
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            while (len > 0) {
                if (count == buffer.length) flush();
                int n = Math.min(len, buffer.length - count);
                System.arraycopy(b, off, buffer, count, n);
                count += n;
                off += n;
                len -= n;
            }
        }

        @Override
        public void flush() throws IOException {
            if (count > 0) {
                sendFrame(buffer, 0, count);
                count = 0;
            }
        }
    }
}
