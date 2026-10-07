package rooftop.security;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * SPAKE2 (RFC 9382) on P-256: two sides that know the same PIN end up with the same secret, and anyone who does
 * not know it learns nothing, not even enough to test PIN guesses offline. A man in the middle gets exactly one
 * guess per connection, and PinGuard shuts a device out after a handful of those.
 *
 * <p>Java has no public elliptic-curve point arithmetic, so the few operations needed are written out here with
 * BigInteger (affine coordinates; a handshake costs a few milliseconds). Works on Android 10.
 */
public final class Spake2 {
    static final BigInteger P = new BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16);
    static final BigInteger A = P.subtract(BigInteger.valueOf(3));
    static final BigInteger B = new BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16);
    static final BigInteger N = new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
    static final Point G = new Point(new BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16),
            new BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16));
    // The two fixed points from RFC 9382 for P-256; nobody knows their discrete logarithm.
    static final Point M = decompress("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
    static final Point NN = decompress("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final boolean client;
    private final BigInteger w;
    private final BigInteger secret;
    private final byte[] share;

    /** {@code client} is the side that opened the connection; it uses M, the other side uses N. */
    public Spake2(boolean client, String pin) throws GeneralSecurityException {
        this.client = client;
        this.w = passwordScalar(pin);
        BigInteger x;
        do {
            x = new BigInteger(256, RANDOM);
        } while (x.signum() == 0 || x.compareTo(N) >= 0);
        this.secret = x;
        this.share = encode(add(mul(x, G), mul(w, client ? M : NN)));
    }

    /** What this side sends: 65 bytes. */
    public byte[] share() {
        return share.clone();
    }

    /** The shared point's x coordinate (32 bytes), from the other side's share. Throws if the share is not a valid point. */
    public byte[] finish(byte[] theirShare) throws GeneralSecurityException {
        Point theirs = decode(theirShare);
        Point k = mul(secret, add(theirs, negate(mul(w, client ? NN : M))));
        if (k == null) throw new GeneralSecurityException("bad key share");
        return fixed(k.x);
    }

    /** The PIN as a scalar. A 6-digit PIN is weak on its own; SPAKE2 is what stops it being guessed offline. */
    static BigInteger passwordScalar(String pin) throws GeneralSecurityException {
        MessageDigest sha = MessageDigest.getInstance("SHA-512");
        sha.update("rooftop spake2 pin v1".getBytes(StandardCharsets.UTF_8));
        sha.update(pin.getBytes(StandardCharsets.UTF_8));
        return new BigInteger(1, sha.digest()).mod(N);
    }

    /* ---- P-256 arithmetic ---- */

    static final class Point {
        final BigInteger x, y;

        Point(BigInteger x, BigInteger y) {
            this.x = x;
            this.y = y;
        }
    }

    private static Point negate(Point p) {
        return p == null ? null : new Point(p.x, P.subtract(p.y).mod(P));
    }

    static Point add(Point p, Point q) {
        if (p == null) return q;
        if (q == null) return p;
        BigInteger slope;
        if (p.x.equals(q.x)) {
            if (!p.y.equals(q.y) || p.y.signum() == 0) return null; // p + (-p)
            slope = p.x.pow(2).multiply(BigInteger.valueOf(3)).add(A).multiply(p.y.shiftLeft(1).modInverse(P)).mod(P);
        } else {
            slope = q.y.subtract(p.y).multiply(q.x.subtract(p.x).modInverse(P)).mod(P);
        }
        BigInteger x = slope.pow(2).subtract(p.x).subtract(q.x).mod(P);
        BigInteger y = slope.multiply(p.x.subtract(x)).subtract(p.y).mod(P);
        return new Point(x, y);
    }

    static Point mul(BigInteger k, Point p) {
        Point result = null;
        for (int i = k.bitLength() - 1; i >= 0; i--) {
            result = add(result, result);
            if (k.testBit(i)) result = add(result, p);
        }
        return result;
    }

    private static boolean onCurve(Point p) {
        return p.y.pow(2).mod(P).equals(p.x.pow(3).add(A.multiply(p.x)).add(B).mod(P));
    }

    static byte[] encode(Point p) {
        byte[] out = new byte[65];
        out[0] = 4;
        System.arraycopy(fixed(p.x), 0, out, 1, 32);
        System.arraycopy(fixed(p.y), 0, out, 33, 32);
        return out;
    }

    static Point decode(byte[] b) throws GeneralSecurityException {
        if (b.length != 65 || b[0] != 4) throw new GeneralSecurityException("bad key share");
        byte[] x = new byte[32], y = new byte[32];
        System.arraycopy(b, 1, x, 0, 32);
        System.arraycopy(b, 33, y, 0, 32);
        Point p = new Point(new BigInteger(1, x), new BigInteger(1, y));
        if (p.x.compareTo(P) >= 0 || p.y.compareTo(P) >= 0 || !onCurve(p)) throw new GeneralSecurityException("bad key share");
        return p;
    }

    private static Point decompress(String hex) {
        BigInteger x = new BigInteger(hex.substring(2), 16);
        BigInteger rhs = x.pow(3).add(A.multiply(x)).add(B).mod(P);
        BigInteger y = rhs.modPow(P.add(BigInteger.ONE).shiftRight(2), P); // P = 3 mod 4
        if (!y.pow(2).mod(P).equals(rhs)) throw new IllegalStateException("not a curve point");
        if (y.testBit(0) != hex.startsWith("03")) y = P.subtract(y);
        return new Point(x, y);
    }

    private static byte[] fixed(BigInteger v) {
        byte[] raw = v.toByteArray(), out = new byte[32];
        int n = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - n, out, 32 - n, n);
        return out;
    }
}
