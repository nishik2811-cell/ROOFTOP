package rooftop.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import rooftop.error.WrongPinException;
import rooftop.util.Texts;

/**
 * One PIN per session. Each device gets a few tries before it is shut out, and the whole network together gets at most
 * {@link #MAX_FAILS_PER_MINUTE} wrong guesses a minute, so changing address cannot speed up guessing. Devices that
 * already got in are never slowed down.
 */
public class PinGuard {
    private static final int MAX_FAILS = 10;
    private static final int MAX_FAILS_PER_MINUTE = 20; // a million PINs at 20 a minute: about 17 days for even odds

    private final java.util.ArrayDeque<Long> recentFails = new java.util.ArrayDeque<>();
    private final Set<String> trusted = new HashSet<>(); // addresses that gave the right PIN this session

    private volatile String pin = newPin();
    /** What the QR code and link carry instead of the PIN: too long to guess, so it never waits behind guessers. */
    private volatile String linkKey = newLinkKey();
    private final Map<String, Integer> fails = new HashMap<>();
    private final Set<String> blocked = new HashSet<>();
    private final Set<String> retired = new HashSet<>(); // PINs of ended sessions

    /** Six random digits. Palindromes such as 123321 or 777777 are re-rolled as too easy to guess. */
    private static String newPin() {
        SecureRandom random = new SecureRandom();
        String p;
        do {
            p = String.format(java.util.Locale.ROOT, "%06d", random.nextInt(1_000_000));
        } while (Texts.isPalindrome(p));
        return p;
    }

    public String pin() {
        return pin;
    }

    /** 12 random letters and digits, about 60 bits: no one finds it by trying. */
    private static String newLinkKey() {
        SecureRandom random = new SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 12; i++) sb.append("abcdefghjkmnpqrstuvwxyz23456789".charAt(random.nextInt(31)));
        return sb.toString();
    }

    public String linkKey() {
        return linkKey;
    }

    /** Ends the session: a fresh PIN, and every device starts again with a clean record. */
    public synchronized void renew() {
        retired.add(pin);
        retired.add(linkKey);
        pin = newPin();
        linkKey = newLinkKey();
        fails.clear();
        blocked.clear();
        trusted.clear();
        recentFails.clear();
    }

    /**
     * Who gets the tries: an IPv4 address, or an IPv6 /64 network. One device can pick any address inside its /64,
     * so counting IPv6 per address would give it endless tries.
     */
    public static String group(String ip) {
        if (ip.indexOf(':') < 0) return ip;
        String[] parts = ip.split("%")[0].split(":", -1);
        return parts.length >= 4 ? String.join(":", java.util.Arrays.copyOf(parts, 4)) + "::/64" : ip;
    }

    /** Too many wrong guesses on the whole network in the last minute: newcomers wait. */
    private boolean throttled(String key) {
        long now = System.currentTimeMillis();
        while (!recentFails.isEmpty() && now - recentFails.peekFirst() > 60_000) recentFails.removeFirst();
        return !trusted.contains(key) && recentFails.size() >= MAX_FAILS_PER_MINUTE;
    }

    private boolean countFail(String key) {
        recentFails.addLast(System.currentTimeMillis());
        int count = fails.merge(key, 1, Integer::sum);
        if (count >= MAX_FAILS) blocked.add(key);
        return count >= MAX_FAILS;
    }

    /** Throws if this device already used up its tries. */
    public synchronized void checkNotBlocked(String ip) throws WrongPinException {
        if (blocked.contains(group(ip))) throw new WrongPinException(ip, true);
        if (throttled(group(ip))) throw new WrongPinException(ip, false, true);
    }

    /** A PC-to-PC handshake from this device failed its PIN check: one try used up. */
    public synchronized boolean fail(String ip) {
        return countFail(group(ip));
    }

    public synchronized void check(String ip, String attempt) throws WrongPinException {
        String key = group(ip);
        if (blocked.contains(key)) throw new WrongPinException(ip, true);
        if (matches(attempt, linkKey)) { // scanned the QR code: in at once, even while someone is guessing PINs
            trusted.add(key);
            return;
        }
        if (throttled(key)) throw new WrongPinException(ip, false, true); // not even checked: a guess now tells nothing
        if (matches(attempt, pin)) {
            trusted.add(key);
            return;
        }
        if (retired.contains(attempt)) throw new WrongPinException(ip, false); // a phone from an old session, not a guess
        throw new WrongPinException(ip, countFail(key));
    }

    private static boolean matches(String attempt, String secret) {
        return attempt != null && MessageDigest.isEqual(attempt.getBytes(StandardCharsets.UTF_8), secret.getBytes(StandardCharsets.UTF_8));
    }
}
