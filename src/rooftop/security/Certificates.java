package rooftop.security;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/**
 * HTTPS for the page. Makes a self-signed certificate on first run, in plain Java, so it works the same on
 * a PC and on Android (which has no keytool). Browsers warn once because no public authority signed it,
 * but the connection is still TLS-encrypted.
 */
public final class Certificates {
    // ponytail: fixed keystore password; the file is only as private as the folder it lives in
    private static final char[] PASSWORD = "rooftop".toCharArray();
    private static final String ECDSA_SHA256 = "1.2.840.10045.4.3.2";
    private static final String COMMON_NAME = "2.5.4.3";
    private static final long TEN_YEARS_MS = 10L * 365 * 24 * 3600 * 1000;

    private Certificates() {
    }

    public static SSLContext load(Path dir) throws IOException, GeneralSecurityException {
        Files.createDirectories(dir);
        Path store = dir.resolve("tls.p12");
        KeyStore keys = KeyStore.getInstance("PKCS12");
        if (Files.exists(store)) {
            try (InputStream in = Files.newInputStream(store)) {
                keys.load(in, PASSWORD);
            }
        } else {
            keys.load(null, null);
            KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
            gen.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair pair = gen.generateKeyPair();
            keys.setKeyEntry("rooftop", pair.getPrivate(), PASSWORD, new Certificate[]{selfSigned(pair)});
            try (OutputStream out = Files.newOutputStream(store)) {
                keys.store(out, PASSWORD);
            }
        }
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(keys, PASSWORD);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(kmf.getKeyManagers(), null, null);
        return tls;
    }

    /** Builds a minimal X.509 v3 certificate by hand (DER encoding) and signs it with the same key. */
    static X509Certificate selfSigned(KeyPair pair) throws GeneralSecurityException {
        byte[] algorithm = seq(oid(ECDSA_SHA256));
        byte[] name = seq(set(seq(oid(COMMON_NAME), tlv(0x0C, "Rooftop".getBytes(StandardCharsets.UTF_8)))));
        long now = System.currentTimeMillis();
        byte[] validity = seq(utcTime(now - 24 * 3600 * 1000), utcTime(now + TEN_YEARS_MS));
        byte[] serial = tlv(0x02, new BigInteger(63, new SecureRandom()).add(BigInteger.ONE).toByteArray());
        byte[] version = tlv(0xA0, tlv(0x02, new byte[]{2}));
        byte[] tbs = seq(version, serial, algorithm, name, validity, name, pair.getPublic().getEncoded());

        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(pair.getPrivate());
        signer.update(tbs);
        byte[] signature = signer.sign();
        byte[] bits = new byte[signature.length + 1]; // leading 0 = no unused bits
        System.arraycopy(signature, 0, bits, 1, signature.length);

        byte[] der = seq(tbs, algorithm, tlv(0x03, bits));
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    private static byte[] seq(byte[]... parts) {
        return tlv(0x30, parts);
    }

    private static byte[] set(byte[]... parts) {
        return tlv(0x31, parts);
    }

    private static byte[] tlv(int tag, byte[]... parts) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] p : parts) body.write(p, 0, p.length);
        int length = body.size();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        if (length < 0x80) {
            out.write(length);
        } else {
            int bytes = length > 0xFFFF ? 3 : length > 0xFF ? 2 : 1;
            out.write(0x80 | bytes);
            for (int i = bytes - 1; i >= 0; i--) out.write(length >>> (8 * i));
        }
        byte[] content = body.toByteArray();
        out.write(content, 0, content.length);
        return out.toByteArray();
    }

    private static byte[] oid(String dotted) {
        String[] parts = dotted.split("\\.");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(Integer.parseInt(parts[0]) * 40 + Integer.parseInt(parts[1]));
        for (int i = 2; i < parts.length; i++) {
            long value = Long.parseLong(parts[i]);
            int groups = 1;
            while ((value >>> (7 * groups)) != 0) groups++;
            for (int g = groups - 1; g >= 0; g--) out.write((int) ((value >>> (7 * g)) & 0x7F) | (g > 0 ? 0x80 : 0));
        }
        return tlv(0x06, out.toByteArray());
    }

    private static byte[] utcTime(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return tlv(0x17, format.format(new Date(millis)).getBytes(StandardCharsets.US_ASCII));
    }
}
