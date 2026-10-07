package rooftop;

import java.io.ByteArrayInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Random;
import rooftop.error.InvalidFileNameException;
import rooftop.model.Inbox;
import rooftop.model.Progress;
import rooftop.security.FileNames;
import rooftop.security.SecureChannel;
import rooftop.security.PinGuard;
import rooftop.util.Streams;
import rooftop.util.Texts;

/** Quick checks for the risky parts. Run: java src/rooftop/SelfTest.java */
public class SelfTest {
    public static void main(String[] args) throws Exception {
        // file names from other devices cannot escape the inbox
        check(FileNames.clean("../../.bashrc").equals(".bashrc"), "path traversal stripped");
        check(FileNames.clean("C:\\Users\\x\\photo.jpg").equals("photo.jpg"), "windows path stripped");
        check(FileNames.withSuffix("a.tar.gz", " (2)").equals("a.tar (2).gz"), "suffix before extension");
        for (String bad : new String[]{"..", ".", "", "x.part", "a\u0001b"}) {
            try {
                FileNames.clean(bad);
                check(false, "rejects '" + bad + "'");
            } catch (InvalidFileNameException expected) {
                // good
            }
        }
        check(Texts.isPalindrome("123321") && !Texts.isPalindrome("123456"), "palindrome PINs detected");

        // a new session gives a new PIN; the old one stops working but does not count as a wrong guess
        PinGuard guard = new PinGuard();
        String old = guard.pin();
        guard.renew();
        boolean oldRejected = false;
        try { guard.check("1.2.3.4", old); } catch (rooftop.error.WrongPinException e) { oldRejected = !e.isBlocked(); }
        for (int i = 0; i < 20; i++) try { guard.check("1.2.3.4", old); } catch (rooftop.error.WrongPinException ignored) { }
        boolean newWorks = true;
        try { guard.check("1.2.3.4", guard.pin()); } catch (rooftop.error.WrongPinException e) { newWorks = false; }
        check(!guard.pin().equals(old) && oldRejected && newWorks, "new session: old PIN refused, phone not locked out");

        // duplicate names get numbered instead of overwriting
        Path dir = Files.createTempDirectory("rooftop-test");
        Inbox inbox = new Inbox(dir);
        byte[] one = {1, 2, 3};
        inbox.store("a.txt", new ByteArrayInputStream(one), 3, "test", new Progress(3));
        String second = inbox.store("a.txt", new ByteArrayInputStream(one), 3, "test", new Progress(3)).name();
        check(second.equals("a (2).txt"), "second a.txt saved as a (2).txt, got " + second);

        // resuming: a connection that dies halfway keeps what arrived, and the next try carries on from there
        byte[] big = new byte[300_000];
        new Random(3).nextBytes(big);
        String id = "0123456789abcdef0123456789abcdef";
        InputStream dying = new ByteArrayInputStream(big, 0, 120_000); // ends early, like a dropped Wi-Fi
        boolean cut = false;
        try { inbox.append(id, 0, dying, big.length, new Progress(big.length)); } catch (java.io.EOFException e) { cut = true; }
        long kept = inbox.received(id);
        boolean refused = false;
        try { inbox.append(id, 0, new ByteArrayInputStream(big), big.length, new Progress(big.length)); }
        catch (rooftop.error.OffsetMismatchException e) { refused = e.expected() == kept; }
        inbox.append(id, kept, new ByteArrayInputStream(big, (int) kept, big.length - (int) kept), big.length - kept, new Progress(big.length));
        String resumed = inbox.finish(id, "big.bin", big.length, "test", "", "*").name();
        check(cut && kept == 120_000 && refused && Arrays.equals(Files.readAllBytes(dir.resolve(resumed)), big),
                "dropped transfer resumes at byte " + kept + " and the file is identical");

        // compression between PCs: text shrinks, random bytes are sent as they are, and nothing after the frames is eaten
        byte[] words = new byte[2_500_000];
        for (int i = 0; i < words.length; i++) words[i] = (byte) "the quick brown fox jumps over the lazy dog\n".charAt(i % 44);
        Object[] text = framesRoundTrip(words, true);
        check(Arrays.equals((byte[]) text[0], words) && (double) text[1] < 0.2 && (boolean) text[2],
                "text goes compressed (" + Math.round((double) text[1] * 100) + "% of its size) and arrives intact");
        Object[] noise = framesRoundTrip(big, true);
        check(Arrays.equals((byte[]) noise[0], big) && (double) noise[1] > 0.99 && (boolean) noise[2], "random bytes are not compressed and arrive intact");
        check(!rooftop.net.Frames.worthTrying("clip.MP4") && rooftop.net.Frames.worthTrying("notes.txt"), "videos are never compressed, text is tried");
        byte[] wire = (byte[]) text[3];
        wire[20] ^= 0x55;
        boolean damaged = false;
        try {
            Streams.copy(new rooftop.net.Frames.Decoder(new ByteArrayInputStream(wire)), new java.io.ByteArrayOutputStream(), words.length, new Progress(words.length));
        } catch (IOException e) {
            damaged = true;
        }
        check(damaged, "a damaged compressed frame is caught");

        // names people pick for their devices
        check("Asha's phone".equals(rooftop.model.Device.cleanName("  Asha's\n  phone\u200b ")) && rooftop.model.Device.cleanName(" \t ") == null
                && rooftop.model.Device.cleanName("x".repeat(50)).length() == 32, "device names are cleaned and capped");

        // encrypted channel: 1 MB survives the trip byte for byte
        byte[] payload = new byte[1 << 20];
        new Random(7).nextBytes(payload);
        check(Arrays.equals(roundTrip(payload, false), payload), "1 MB arrives intact through SecureChannel");

        // ...and a single flipped bit on the wire is caught, not saved
        boolean caught = false;
        try {
            roundTrip(payload, true);
        } catch (IOException e) {
            caught = e.getMessage().contains("tampered");
        }
        check(caught, "tampered ciphertext is rejected");
        System.out.println("all checks passed");
    }

    /** Encodes data as Frames followed by a marker byte, decodes it again: {decoded, ratio, marker intact, wire bytes}. */
    private static Object[] framesRoundTrip(byte[] data, boolean tryCompress) throws IOException {
        java.io.ByteArrayOutputStream wire = new java.io.ByteArrayOutputStream();
        rooftop.net.Frames.Encoder enc = new rooftop.net.Frames.Encoder(wire, tryCompress);
        enc.write(data, 0, data.length);
        enc.finish();
        wire.write(42); // stands in for the checksum that follows the frames on a real connection
        byte[] bytes = wire.toByteArray();
        InputStream in = new ByteArrayInputStream(bytes);
        java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream();
        Streams.copy(new rooftop.net.Frames.Decoder(in), got, data.length, new Progress(data.length));
        return new Object[]{got.toByteArray(), enc.ratio(), in.read() == 42, bytes};
    }

    /** Sends {@code data} through a SecureChannel over loopback, optionally via a relay that flips one bit. */
    private static byte[] roundTrip(byte[] data, boolean tamper) throws Exception {
        try (ServerSocket receiver = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
             ServerSocket relay = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            Thread middle = new Thread(() -> {
                try (Socket fromSender = relay.accept();
                     Socket toReceiver = new Socket(InetAddress.getLoopbackAddress(), receiver.getLocalPort())) {
                    Thread back = new Thread(() -> pipe(toReceiver, fromSender, -1));
                    back.start();
                    pipe(fromSender, toReceiver, tamper ? 5000 : -1);
                    back.join();
                } catch (Exception ignored) {
                    // the receiver hanging up early is expected in the tamper case
                }
            });
            middle.start();
            Thread sender = new Thread(() -> {
                try (Socket s = new Socket(InetAddress.getLoopbackAddress(), relay.getLocalPort())) {
                    SecureChannel ch = SecureChannel.open(s, true);
                    DataOutputStream out = new DataOutputStream(ch.output());
                    out.write(data);
                    out.flush();
                    ch.input().read(); // wait for the receiver before closing
                } catch (IOException ignored) {
                    // receiver may hang up in the tamper case
                }
            });
            sender.start();
            try (Socket s = receiver.accept()) {
                SecureChannel ch = SecureChannel.open(s, false);
                java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream();
                Streams.copy(ch.input(), got, data.length, new Progress(data.length));
                ch.output().write(1);
                ch.output().flush();
                return got.toByteArray();
            }
        }
    }

    /** Copies bytes between sockets; flips one bit at position {@code flipAt} (if not -1). */
    private static void pipe(Socket from, Socket to, long flipAt) {
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            long pos = 0;
            int b;
            while ((b = in.read()) != -1) {
                if (pos++ == flipAt) b ^= 0x01;
                out.write(b);
            }
            to.shutdownOutput();
        } catch (IOException ignored) {
            // one side closed
        }
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError("FAILED: " + what);
        System.out.println("ok  " + what);
    }
}
