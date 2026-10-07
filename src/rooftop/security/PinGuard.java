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

/** One PIN per session. Each device gets a few tries before it is shut out. */
public class PinGuard {
    private static final int MAX_FAILS = 10;

    private volatile String pin = newPin();
    private final Map<String, Integer> fails = new HashMap<>();
    private final Set<String> blocked = new HashSet<>();
    private final Set<String> retired = new HashSet<>(); // PINs of ended sessions

    /** Six random digits. Palindromes such as 123321 or 777777 are re-rolled as too easy to guess. */
    private static String newPin() {
        SecureRandom random = new SecureRandom();
        String p;
        do {
            p = String.format("%06d", random.nextInt(1_000_000));
        } while (Texts.isPalindrome(p));
        return p;
    }

    public String pin() {
        return pin;
    }

    /** Ends the session: a fresh PIN, and every device starts again with a clean record. */
    public synchronized void renew() {
        retired.add(pin);
        pin = newPin();
        fails.clear();
        blocked.clear();
    }

    /** Throws if this device already used up its tries. */
    public synchronized void checkNotBlocked(String ip) throws WrongPinException {
        if (blocked.contains(ip)) throw new WrongPinException(ip, true);
    }

    /** A PC-to-PC handshake from this device failed its PIN check: one try used up. */
    public synchronized boolean fail(String ip) {
        int count = fails.merge(ip, 1, Integer::sum);
        if (count >= MAX_FAILS) blocked.add(ip);
        return count >= MAX_FAILS;
    }

    public synchronized void check(String ip, String attempt) throws WrongPinException {
        if (blocked.contains(ip)) throw new WrongPinException(ip, true);
        if (attempt != null && MessageDigest.isEqual(
                attempt.getBytes(StandardCharsets.UTF_8), pin.getBytes(StandardCharsets.UTF_8))) return;
        if (retired.contains(attempt)) throw new WrongPinException(ip, false); // a phone from an old session, not a guess
        int count = fails.merge(ip, 1, Integer::sum);
        if (count >= MAX_FAILS) blocked.add(ip);
        throw new WrongPinException(ip, count >= MAX_FAILS);
    }
}
