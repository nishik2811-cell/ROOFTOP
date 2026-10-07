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

/** One PIN per run. Each device gets a few tries before it is shut out. */
public class PinGuard {
    private static final int MAX_FAILS = 10;

    private final String pin = newPin();
    private final Map<String, Integer> fails = new HashMap<>();
    private final Set<String> blocked = new HashSet<>();

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

    public synchronized void check(String ip, String attempt) throws WrongPinException {
        if (blocked.contains(ip)) throw new WrongPinException(ip, true);
        if (attempt != null && MessageDigest.isEqual(
                attempt.getBytes(StandardCharsets.UTF_8), pin.getBytes(StandardCharsets.UTF_8))) return;
        int count = fails.merge(ip, 1, Integer::sum);
        if (count >= MAX_FAILS) blocked.add(ip);
        throw new WrongPinException(ip, count >= MAX_FAILS);
    }
}
