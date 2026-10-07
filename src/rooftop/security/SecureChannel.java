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
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import rooftop.util.Streams;

/**
 * Encrypted pipe over a TCP socket, used for every PC-to-PC transfer.
 *
 * Handshake: each side sends a fresh elliptic-curve (P-256) public key, both derive the same shared secret, and it is
 * hashed into one AES-256-GCM key per direction. After that every 64 KB chunk travels as its own
 * encrypted, authenticated frame, so someone sniffing the Wi-Fi sees noise, and a single flipped bit
 * makes the receiver stop instead of saving a corrupted file.
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
    private long sendCounter;
    private long receiveCounter;
    private final InputStream input = new FrameInputStream();
    private final OutputStream output;

    private SecureChannel(Socket socket, boolean initiator, int frameSize) throws IOException, GeneralSecurityException {
        this.socket = socket;
        this.output = new FrameOutputStream(Math.min(frameSize, Streams.MAX_CHUNK));
        this.rawIn = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
        this.rawOut = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream()));

        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair mine = generator.generateKeyPair();
        byte[] myKey = mine.getPublic().getEncoded();
        rawOut.writeShort(myKey.length);
        rawOut.write(myKey);
        rawOut.flush();

        int length = rawIn.readUnsignedShort();
        if (length > MAX_KEY) throw new IOException("handshake key too large");
        byte[] theirKey = Streams.readFully(rawIn, length);
        PublicKey theirs = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(theirKey));

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(mine.getPrivate());
        agreement.doPhase(theirs, true);
        byte[] secret = agreement.generateSecret();

        byte[] clientKey = initiator ? myKey : theirKey;
        byte[] serverKey = initiator ? theirKey : myKey;
        SecretKey toServer = derive(secret, clientKey, serverKey, "client to server");
        SecretKey toClient = derive(secret, clientKey, serverKey, "server to client");
        this.sendKey = initiator ? toServer : toClient;
        this.receiveKey = initiator ? toClient : toServer;
    }

    /** Runs the key exchange. {@code initiator} is true on the side that opened the connection. */
    public static SecureChannel open(Socket socket, boolean initiator) throws IOException {
        return open(socket, initiator, Streams.CHUNK);
    }

    /** Same, with an explicit frame size (the benchmark compares 64 KB to 1 MB). */
    public static SecureChannel open(Socket socket, boolean initiator, int frameSize) throws IOException {
        try {
            return new SecureChannel(socket, initiator, frameSize);
        } catch (GeneralSecurityException e) {
            throw new IOException("encryption handshake failed: " + e.getMessage(), e);
        }
    }

    private static SecretKey derive(byte[] secret, byte[] clientKey, byte[] serverKey, String label)
            throws GeneralSecurityException {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        sha.update("rooftop v2".getBytes(StandardCharsets.UTF_8));
        sha.update(secret);
        sha.update(clientKey);
        sha.update(serverKey);
        sha.update(label.getBytes(StandardCharsets.UTF_8));
        return new SecretKeySpec(sha.digest(), "AES");
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
