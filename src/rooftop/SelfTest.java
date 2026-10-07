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
        // end-to-end files: the PC stores only ciphertext without the name, and forgets the transfer after the last ack
        byte[] secretText = "the plans for saturday, do not tell anyone\n".repeat(8000).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        java.security.KeyPair sender = Rte2.pair(), phoneB = Rte2.pair(), phoneC = Rte2.pair(), stranger = Rte2.pair();
        byte[] blob = Rte2.seal(secretText, "saturday-plans.txt", java.util.List.of(Rte2.raw(phoneB), Rte2.raw(phoneC)), sender);
        Path sealedDir = Files.createTempDirectory("rooftop-sealed-test");
        Path heldDir = Files.createTempDirectory("rooftop-held-test");
        rooftop.model.SealedBox box = new rooftop.model.SealedBox(sealedDir, heldDir, "host");
        String tid = "00112233445566778899aabbccddeeff";
        box.append(tid, java.util.Set.of("web B", "web C"), blob.length, 0, new ByteArrayInputStream(blob), blob.length);
        byte[] stored = Files.readAllBytes(sealedDir.resolve(tid));
        check(!Arrays.equals(stored, secretText) && Rte2.indexOf(stored, "saturday".getBytes(java.nio.charset.StandardCharsets.UTF_8)) < 0
                && Rte2.indexOf(stored, "the plans".getBytes(java.nio.charset.StandardCharsets.UTF_8)) < 0,
                "the PC's stored copy differs from the original and contains neither the file name nor its text");
        check(stored.length >= 64 * 1024 && box.waitingFor("web B").size() == 1 && box.waitingFor("web X").isEmpty(),
                "it is padded (" + stored.length + " bytes for a " + secretText.length + "-byte file) and offered only to its recipients");
        Object[] openedB = Rte2.open(Files.readAllBytes(box.collect(tid, "web B")), phoneB);
        Object[] openedC = Rte2.open(Files.readAllBytes(box.collect(tid, "web C")), phoneC);
        check("saturday-plans.txt".equals(openedB[0]) && Arrays.equals((byte[]) openedB[1], secretText) && Arrays.equals((byte[]) openedC[1], secretText),
                "each recipient opens its own copy, name and bytes intact");
        String strangerResult = Rte2.tryOpen(stored, stranger);
        byte[] swappedBlob = stored.clone();
        System.arraycopy(Rte2.raw(stranger), 0, swappedBlob, 8 + 7, 65); // someone puts their own key in as the sender's
        String swappedResult = Rte2.tryOpen(swappedBlob, phoneB);
        check(strangerResult.contains("not sealed for") && swappedResult.contains("swapped"),
                "a stranger cannot open it, and a swapped sender key is detected (" + swappedResult + ")");
        box.acknowledge(tid, "web B");
        boolean stillThere = Files.exists(sealedDir.resolve(tid)) && box.waitingFor("web C").size() == 1;
        box.acknowledge(tid, "web C");
        boolean gone = !Files.exists(sealedDir.resolve(tid)) && box.count() == 0 && box.waitingFor("web C").isEmpty();
        boolean collectRefused = false;
        try { box.collect(tid, "web C"); } catch (java.nio.file.NoSuchFileException e) { collectRefused = true; }
        String[] leftovers;
        try (var list = Files.list(sealedDir)) { leftovers = list.map(p -> p.getFileName().toString()).toArray(String[]::new); }
        check(stillThere && gone && collectRefused && leftovers.length == 0, "nothing about the transfer is left after the last acknowledgement");

        // a file for this PC (here sent to Everyone: the PC and C) is held until the PC's page opens it
        String forPc = "ffeeddccbbaa99887766554433221100";
        box.append(forPc, java.util.Set.of("host", "web C"), blob.length, 0, new ByteArrayInputStream(blob), blob.length);
        box.clear(); // End session
        boolean afterSession = box.waitingFor("host").size() == 1 && box.waitingFor("web C").isEmpty();
        rooftop.model.SealedBox restarted = new rooftop.model.SealedBox(sealedDir, heldDir, "host"); // Rooftop restarts
        boolean afterRestart = restarted.waitingFor("host").size() == 1 && Arrays.equals(Files.readAllBytes(restarted.collect(forPc, "host")), blob);
        restarted.acknowledge(forPc, "host");
        String[] heldLeft;
        try (var list = Files.list(heldDir)) { heldLeft = list.map(p -> p.getFileName().toString()).toArray(String[]::new); }
        check(afterSession && afterRestart && heldLeft.length == 0 && restarted.count() == 0,
                "a file for the PC survives End session and a restart, and goes only once the PC's page acknowledges it");

        // chat: the PC relays sealed messages it cannot read, padded, and forgets every one of them at session end
        Path chatHome = Files.createTempDirectory("rooftop-chat-test");
        Rooftop room = new Rooftop(new Platform() {
            public String deviceName() { return "test PC"; }
            public Path inboxDir() { return chatHome.resolve("Rooftop"); }
            public byte[] asset(String name) { return new byte[0]; }
            public void setClipboard(String text) { }
            public String clipboard() { return ""; }
        });
        String hello = "meet at the roof at six, bring the speaker";
        byte[] msg = Rte2.sealMessage("{\"k\":\"msg\",\"c\":\"all\",\"t\":" + Texts.json(hello) + "}",
                java.util.List.of(Rte2.raw(phoneB), Rte2.raw(phoneC)), sender);
        byte[] shortMsg = Rte2.sealMessage("{\"k\":\"msg\",\"c\":\"all\",\"t\":\"ok\"}", java.util.List.of(Rte2.raw(phoneB), Rte2.raw(phoneC)), sender);
        room.chat().add("web A", java.util.Set.of("web B", "web C"), msg, 0);
        byte[] storedMsg = room.chat().since(0, "web B").get(0).bytes();
        int body = storedMsg.length - (4 + 7 + 66 + 2 * (8 + 65 + 16 + 48)) - 16;
        check(Rte2.indexOf(storedMsg, "meet at the roof".getBytes(java.nio.charset.StandardCharsets.UTF_8)) < 0 && body % 64 == 0
                && body >= 256 && shortMsg.length == msg.length && Rte2.openMessage(storedMsg, phoneC).contains(hello),
                "a stored chat message is not its text, is padded (\"ok\" and a whole sentence store the same size, " + msg.length + " bytes), and only recipients read it");
        String groupName = "Saturday crew";
        byte[] groupMsg = Rte2.sealMessage("{\"k\":\"group\",\"g\":\"abc\",\"n\":" + Texts.json(groupName) + ",\"m\":[\"web A\",\"web B\"]}",
                java.util.List.of(Rte2.raw(phoneB)), sender);
        room.chat().add("web A", java.util.Set.of("web A", "web B"), groupMsg, 0);
        boolean nameHidden = room.chat().all().stream().noneMatch(e -> Rte2.indexOf(e.bytes(), "Saturday".getBytes(java.nio.charset.StandardCharsets.UTF_8)) >= 0);
        check(nameHidden && room.chat().since(0, "web C").size() == 1, "a group's name is not stored in plaintext, and non-members are not handed its envelope");
        room.newSession();
        check(room.chat().all().isEmpty() && room.chat().since(0, "web B").isEmpty(), "ending the session clears every message and group");

        // PC to PC: the handshake is tied to the receiver's PIN, so a wrong PIN or a swapped key fails before any data
        String[] right = handshake("482915", "482915", false);
        check(right[0].equals("ok") && right[1].equals("ok") && right[2].equals(right[3]) && right[4].equals("hello"),
                "right PIN: handshake succeeds, both PCs show safety code " + right[2] + ", data arrives");
        String[] wrong = handshake("482916", "482915", false);
        check(wrong[0].equals("pin") && wrong[1].equals("pin") && wrong[4].isEmpty(), "wrong PIN: handshake fails on both sides, no data gets through");
        String[] swapped = handshake("482915", "482915", true);
        check(!swapped[0].equals("ok") && !swapped[1].equals("ok") && swapped[4].isEmpty(),
                "a key swapped by someone in the middle is detected (" + swapped[0] + "/" + swapped[1] + "), no data gets through");
        rooftop.security.PinGuard guard2 = new rooftop.security.PinGuard();
        for (int i = 0; i < 10; i++) guard2.fail("9.9.9.9");
        boolean shutOut = false;
        try { guard2.checkNotBlocked("9.9.9.9"); } catch (rooftop.error.WrongPinException e) { shutOut = e.isBlocked(); }
        check(shutOut, "after 10 failed handshakes that PC is shut out");

        System.out.println("all checks passed");
    }

    /**
     * The browser's sealed format (web/e2e.js, "RTE2") redone in Java, so the PC side can be checked without a
     * browser: a random file key per file, wrapped for each recipient with HKDF over two ECDH results.
     */
    static final class Rte2 {
        private static final int CHUNK = 1 << 20, ID = 7, ENTRY = 8 + 65 + 16 + 48;
        private static final byte[] WRAP_INFO = "rooftop end-to-end v2 wrap".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

        static java.security.KeyPair pair() throws Exception {
            java.security.KeyPairGenerator g = java.security.KeyPairGenerator.getInstance("EC");
            g.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
            return g.generateKeyPair();
        }

        static byte[] raw(java.security.KeyPair p) {
            java.security.spec.ECPoint w = ((java.security.interfaces.ECPublicKey) p.getPublic()).getW();
            byte[] out = new byte[65];
            out[0] = 4;
            copy32(w.getAffineX(), out, 1);
            copy32(w.getAffineY(), out, 33);
            return out;
        }

        private static void copy32(java.math.BigInteger v, byte[] out, int at) {
            byte[] b = v.toByteArray();
            int n = Math.min(32, b.length);
            System.arraycopy(b, b.length - n, out, at + 32 - n, n);
        }

        private static byte[] dh(java.security.KeyPair mine, byte[] otherRaw) throws Exception {
            var params = ((java.security.interfaces.ECPublicKey) mine.getPublic()).getParams();
            var point = new java.security.spec.ECPoint(new java.math.BigInteger(1, Arrays.copyOfRange(otherRaw, 1, 33)),
                    new java.math.BigInteger(1, Arrays.copyOfRange(otherRaw, 33, 65)));
            var other = java.security.KeyFactory.getInstance("EC").generatePublic(new java.security.spec.ECPublicKeySpec(point, params));
            javax.crypto.KeyAgreement ka = javax.crypto.KeyAgreement.getInstance("ECDH");
            ka.init(mine.getPrivate());
            ka.doPhase(other, true);
            return ka.generateSecret();
        }

        private static byte[] hmac(byte[] key, byte[]... parts) throws Exception {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"));
            for (byte[] p : parts) mac.update(p);
            return mac.doFinal();
        }

        private static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info) throws Exception {
            return hmac(hmac(salt, ikm), info, new byte[]{1});
        }

        private static byte[] gcm(int mode, byte[] key, byte[] iv, byte[] data) throws Exception {
            javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            c.init(mode, new javax.crypto.spec.SecretKeySpec(key, "AES"), new javax.crypto.spec.GCMParameterSpec(128, iv));
            return c.doFinal(data);
        }

        private static byte[] nonce(byte[] fileId, int index, boolean last, boolean details) {
            byte[] n = new byte[12];
            System.arraycopy(fileId, 0, n, 0, ID);
            n[7] = (byte) ((last ? 1 : 0) | (details ? 2 : 0));
            n[8] = (byte) (index >>> 24); n[9] = (byte) (index >>> 16); n[10] = (byte) (index >>> 8); n[11] = (byte) index;
            return n;
        }

        private static byte[] cat(byte[]... parts) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            for (byte[] p : parts) out.write(p, 0, p.length);
            return out.toByteArray();
        }

        private static byte[] tag(byte[] raw) throws Exception {
            return Arrays.copyOf(java.security.MessageDigest.getInstance("SHA-256").digest(raw), 8);
        }

        static long paddedSize(long size) {
            if (size <= 65536) return 65536;
            long step = 1L << (63 - Long.numberOfLeadingZeros(size) - 4);
            return (size + step - 1) / step * step;
        }

        static byte[] seal(byte[] data, String name, java.util.List<byte[]> recipients, java.security.KeyPair sender) throws Exception {
            byte[] fileId = new byte[ID], fileKey = new byte[32];
            RANDOM.nextBytes(fileId);
            RANDOM.nextBytes(fileKey);
            byte[] senderRaw = raw(sender);
            java.io.ByteArrayOutputStream entries = new java.io.ByteArrayOutputStream();
            for (byte[] r : recipients) {
                java.security.KeyPair eph = pair();
                byte[] ephRaw = raw(eph), salt = new byte[16];
                RANDOM.nextBytes(salt);
                byte[] k = hkdf(cat(dh(eph, r), dh(sender, r)), salt, cat(WRAP_INFO, fileId, senderRaw, ephRaw, r));
                entries.write(cat(tag(r), ephRaw, salt, gcm(javax.crypto.Cipher.ENCRYPT_MODE, k, new byte[12], fileKey)));
            }
            byte[] json = ("{\"name\":" + Texts.json(name) + ",\"size\":" + data.length + "}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
            byte[] padded = Arrays.copyOf(json, (json.length + 1 + 255) / 256 * 256);
            byte[] details = gcm(javax.crypto.Cipher.ENCRYPT_MODE, fileKey, nonce(fileId, 0, true, true), padded);
            byte[] header = cat(fileId, senderRaw, new byte[]{(byte) recipients.size()}, entries.toByteArray(),
                    java.nio.ByteBuffer.allocate(4).putInt(details.length).array(), details);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            out.write(new byte[]{'R', 'T', 'E', '2'});
            out.write(java.nio.ByteBuffer.allocate(4).putInt(header.length).array());
            out.write(header);
            byte[] plain = Arrays.copyOf(data, (int) paddedSize(data.length)); // zeros past the end: padding
            int n = Math.max(1, (plain.length + CHUNK - 1) / CHUNK);
            for (int i = 0; i < n; i++)
                out.write(gcm(javax.crypto.Cipher.ENCRYPT_MODE, fileKey, nonce(fileId, i, i == n - 1, false),
                        Arrays.copyOfRange(plain, i * CHUNK, Math.min(plain.length, (i + 1) * CHUNK))));
            return out.toByteArray();
        }

        /** {name, bytes}; throws if this key is not a recipient or anything was changed. */
        static Object[] open(byte[] blob, java.security.KeyPair me) throws Exception {
            java.nio.ByteBuffer in = java.nio.ByteBuffer.wrap(blob);
            if (in.getInt() != 0x52544532) throw new IOException("not a sealed file");
            int headerLength = in.getInt();
            byte[] header = new byte[headerLength];
            in.get(header);
            byte[] fileId = Arrays.copyOf(header, ID), senderRaw = Arrays.copyOfRange(header, ID, ID + 65), myRaw = raw(me), myTag = tag(myRaw);
            int count = header[ID + 65] & 0xFF;
            byte[] fileKey = null;
            for (int i = 0; i < count; i++) {
                int at = ID + 66 + i * ENTRY;
                if (!Arrays.equals(Arrays.copyOfRange(header, at, at + 8), myTag)) continue;
                byte[] ephRaw = Arrays.copyOfRange(header, at + 8, at + 73), salt = Arrays.copyOfRange(header, at + 73, at + 89);
                byte[] k = hkdf(cat(dh(me, ephRaw), dh(me, senderRaw)), salt, cat(WRAP_INFO, fileId, senderRaw, ephRaw, myRaw));
                try {
                    fileKey = gcm(javax.crypto.Cipher.DECRYPT_MODE, k, new byte[12], Arrays.copyOfRange(header, at + 89, at + ENTRY));
                } catch (javax.crypto.AEADBadTagException e) {
                    throw new IOException("the sender's key does not match: it was swapped or damaged on the way");
                }
            }
            if (fileKey == null) throw new IOException("this file was not sealed for this device");
            int at = ID + 66 + count * ENTRY;
            int detailsLength = java.nio.ByteBuffer.wrap(header, at, 4).getInt();
            String json = new String(gcm(javax.crypto.Cipher.DECRYPT_MODE, fileKey, nonce(fileId, 0, true, true),
                    Arrays.copyOfRange(header, at + 4, at + 4 + detailsLength)), java.nio.charset.StandardCharsets.UTF_8).replace("\u0000", "");
            String name = json.replaceAll(".*\"name\":\"([^\"]*)\".*", "$1");
            int size = Integer.parseInt(json.replaceAll(".*\"size\":(\\d+).*", "$1"));
            java.io.ByteArrayOutputStream plain = new java.io.ByteArrayOutputStream();
            for (int i = 0; in.hasRemaining(); i++) {
                byte[] sealed = new byte[Math.min(in.remaining(), CHUNK + 16)];
                in.get(sealed);
                plain.write(gcm(javax.crypto.Cipher.DECRYPT_MODE, fileKey, nonce(fileId, i, !in.hasRemaining(), false), sealed));
            }
            return new Object[]{name, Arrays.copyOf(plain.toByteArray(), size)};
        }

        /** A chat envelope ("RTM1"): a fresh key per message, wrapped per recipient, JSON zero-padded to 256 bytes, then to 64. */
        static byte[] sealMessage(String json, java.util.List<byte[]> recipients, java.security.KeyPair sender) throws Exception {
            byte[] id = new byte[ID], key = new byte[32];
            RANDOM.nextBytes(id);
            RANDOM.nextBytes(key);
            byte[] senderRaw = raw(sender);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            out.write(new byte[]{'R', 'T', 'M', '1'});
            out.write(id);
            out.write(senderRaw);
            out.write(recipients.size());
            for (byte[] r : recipients) {
                java.security.KeyPair eph = pair();
                byte[] ephRaw = raw(eph), salt = new byte[16];
                RANDOM.nextBytes(salt);
                byte[] k = hkdf(cat(dh(eph, r), dh(sender, r)), salt, cat(MSG_INFO, id, senderRaw, ephRaw, r));
                out.write(cat(tag(r), ephRaw, salt, gcm(javax.crypto.Cipher.ENCRYPT_MODE, k, new byte[12], key)));
            }
            byte[] plain = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            out.write(gcm(javax.crypto.Cipher.ENCRYPT_MODE, key, nonce(id, 0, true, true), Arrays.copyOf(plain, Math.max(256, (plain.length + 1 + 63) / 64 * 64))));
            return out.toByteArray();
        }

        static String openMessage(byte[] b, java.security.KeyPair me) throws Exception {
            byte[] id = Arrays.copyOfRange(b, 4, 4 + ID), senderRaw = Arrays.copyOfRange(b, 4 + ID, 4 + ID + 65), myRaw = raw(me), myTag = tag(myRaw);
            int count = b[4 + ID + 65] & 0xFF, start = 4 + ID + 66;
            for (int i = 0; i < count; i++) {
                int at = start + i * ENTRY;
                if (!Arrays.equals(Arrays.copyOfRange(b, at, at + 8), myTag)) continue;
                byte[] ephRaw = Arrays.copyOfRange(b, at + 8, at + 73), salt = Arrays.copyOfRange(b, at + 73, at + 89);
                byte[] k = hkdf(cat(dh(me, ephRaw), dh(me, senderRaw)), salt, cat(MSG_INFO, id, senderRaw, ephRaw, myRaw));
                byte[] key = gcm(javax.crypto.Cipher.DECRYPT_MODE, k, new byte[12], Arrays.copyOfRange(b, at + 89, at + ENTRY));
                return new String(gcm(javax.crypto.Cipher.DECRYPT_MODE, key, nonce(id, 0, true, true), Arrays.copyOfRange(b, start + count * ENTRY, b.length)),
                        java.nio.charset.StandardCharsets.UTF_8).replace("\u0000", "");
            }
            throw new IOException("not for this key");
        }

        private static final byte[] MSG_INFO = "rooftop chat v1 wrap".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        static String tryOpen(byte[] blob, java.security.KeyPair me) {
            try {
                open(blob, me);
                return "opened";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }

        static int indexOf(byte[] hay, byte[] needle) {
            outer:
            for (int i = 0; i + needle.length <= hay.length; i++) {
                for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
                return i;
            }
            return -1;
        }
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
                    SecureChannel ch = SecureChannel.open(s, true, "123456");
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
                SecureChannel ch = SecureChannel.open(s, false, "123456");
                java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream();
                Streams.copy(ch.input(), got, data.length, new Progress(data.length));
                ch.output().write(1);
                ch.output().flush();
                return got.toByteArray();
            }
        }
    }

    /**
     * One PC-to-PC handshake over loopback, optionally through a relay that swaps the sender's public key for its own.
     * Returns {client result, server result, client code, server code, what the server received} where a result is
     * "ok", "pin" (PinMismatchException) or the error message.
     */
    private static String[] handshake(String clientPin, String serverPin, boolean swapKey) throws Exception {
        String[] out = {"", "", "", "", ""};
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
             ServerSocket relay = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            Thread middle = new Thread(() -> {
                try (Socket fromClient = relay.accept(); Socket toServer = new Socket(InetAddress.getLoopbackAddress(), server.getLocalPort())) {
                    Thread back = new Thread(() -> pipe(toServer, fromClient, -1));
                    back.start();
                    InputStream in = fromClient.getInputStream();
                    OutputStream o = toServer.getOutputStream();
                    byte[] head = Streams.readFully(in, 5 + 2);
                    int len = ((head[5] & 0xFF) << 8) | (head[6] & 0xFF);
                    Streams.readFully(in, len);
                    java.security.KeyPairGenerator g = java.security.KeyPairGenerator.getInstance("EC");
                    g.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
                    byte[] attacker = g.generateKeyPair().getPublic().getEncoded();
                    o.write(head);
                    o.write(attacker); // same length, a valid key, just not the sender's
                    o.flush();
                    pipe(fromClient, toServer, -1);
                    back.join();
                } catch (Exception ignored) {
                    // one side hung up
                }
            });
            if (swapKey) middle.start();
            int port = swapKey ? relay.getLocalPort() : server.getLocalPort();
            Thread client = new Thread(() -> {
                try (Socket s = new Socket(InetAddress.getLoopbackAddress(), port)) {
                    SecureChannel ch = SecureChannel.open(s, true, clientPin);
                    out[0] = "ok";
                    out[2] = ch.safetyCode();
                    ch.output().write("hello".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    ch.output().flush();
                    ch.input().read();
                } catch (rooftop.error.PinMismatchException e) {
                    out[0] = "pin";
                } catch (IOException e) {
                    if (out[0].isEmpty()) out[0] = e.getMessage();
                }
            });
            client.start();
            try (Socket s = server.accept()) {
                s.setSoTimeout(5000);
                SecureChannel ch = SecureChannel.open(s, false, serverPin);
                out[1] = "ok";
                out[3] = ch.safetyCode();
                out[4] = new String(Streams.readFully(ch.input(), 5), java.nio.charset.StandardCharsets.UTF_8);
                ch.output().write(1);
                ch.output().flush();
            } catch (rooftop.error.PinMismatchException e) {
                out[1] = "pin";
            } catch (IOException e) {
                out[1] = e.getMessage();
            }
            client.join(5000);
        }
        return out;
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
