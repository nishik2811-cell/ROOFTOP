package rooftop.net;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import rooftop.Rooftop;
import rooftop.error.RooftopException;
import rooftop.model.History;
import rooftop.model.Payload;
import rooftop.model.Transfer;
import rooftop.util.Texts;
import rooftop.util.Threads;

/**
 * Producer/consumer. The shell thread submits transfers; a few sender threads deliver them side by side.
 * Smallest first, so a quick text never waits behind a movie, with two guarantees the other way round:
 * one sender only ever takes small payloads, and anything queued for more than {@link #AGING_MS} goes next.
 * Inter-thread communication is plain wait() / notifyAll() on this object's monitor.
 */
public class SendQueue {
    private static final int WORKERS = 3;
    private static final long SMALL = 1 << 20;
    private static final long AGING_MS = 30_000;
    private static final int ATTEMPTS = 3;

    private final LinkedList<Transfer> queue = new LinkedList<>();
    private final Set<Transfer> active = new LinkedHashSet<>();
    private final Rooftop app;

    public SendQueue(Rooftop app) {
        this.app = app;
    }

    public void start() {
        for (int i = 1; i <= WORKERS; i++) Threads.daemon("sender-" + i, () -> work(false));
        Threads.daemon("sender-express", () -> work(true));
        Threads.daemon("send-meter", this::meter);
    }

    /** Producer side. */
    public synchronized void submit(Transfer transfer) {
        queue.add(transfer);
        queue.sort(Comparator.comparing(Transfer::payload));
        notifyAll();
    }

    /** Consumer side: sleeps in wait() until there is something this sender may take. */
    private synchronized Transfer take(boolean smallOnly) throws InterruptedException {
        while (true) {
            Transfer next = pick(smallOnly);
            if (next != null) {
                queue.remove(next);
                active.add(next);
                return next;
            }
            wait(smallOnly || queue.isEmpty() ? 0 : AGING_MS); // wake up to let a long-waiting file jump ahead
        }
    }

    private Transfer pick(boolean smallOnly) {
        if (queue.isEmpty()) return null;
        if (smallOnly) return queue.getFirst().payload().size() <= SMALL ? queue.getFirst() : null;
        long now = System.currentTimeMillis();
        for (Transfer t : queue) if (now - t.queuedAt() > AGING_MS) return t; // waited long enough
        return queue.getFirst();
    }

    private synchronized void swap(Transfer from, Transfer to) {
        active.remove(from);
        if (to != null) active.add(to);
    }

    private void work(boolean smallOnly) {
        try {
            while (true) deliver(take(smallOnly));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Network errors are retried (each retry resumes where the last one stopped); a refusal is not. */
    private void deliver(Transfer t) throws InterruptedException {
        String failure = null;
        Transfer current = t;
        try {
            for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
                Transfer tryThis = attempt == 1 ? t : t.retry();
                swap(current, tryThis);
                current = tryThis;
                try {
                    TransferClient.send(tryThis);
                    failure = null;
                    break;
                } catch (RooftopException e) {
                    failure = e.getMessage();
                    break;
                } catch (IOException e) {
                    failure = e.getMessage();
                    if (attempt < ATTEMPTS) app.log().add("send to " + t.target().name() + " failed (" + failure + "), retrying " + (attempt + 1) + "/" + ATTEMPTS);
                }
                if (attempt < ATTEMPTS) Thread.sleep(1000L * attempt); // 1 s, then 2 s: give the Wi-Fi a moment
            }
        } finally {
            swap(current, null);
        }
        boolean ok = failure == null;
        String compressed = ok && current.wireRatio() < 0.95
                ? String.format(Locale.ROOT, ", compressed to %d%%", Math.round(current.wireRatio() * 100)) : "";
        String code = current.safetyCode().isEmpty() ? "" : ", safety code " + current.safetyCode();
        app.log().add(ok ? "sent " + t.payload().describe() + " to " + t.target().name() + ", " + current.speed() + compressed + code
                : "could not send to " + t.target().name() + ": " + failure);
        if (Payload.FILE.equals(t.payload().wireType()))
            app.history().add(new History.Entry(System.currentTimeMillis(), t.payload().name(), t.payload().size(), app.me().name(),
                    app.me().id(), t.target().id(), t.target().name(), ok, current.millis(), current.wireRatio(), ok ? "" : failure));
    }

    private static String pad(int n) { // String.repeat is missing on older Android
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(' ');
        return sb.toString();
    }

    /** One status line for everything that is sending: name, percent, speed and time left. */
    private void meter() {
        Map<Transfer, Long> last = new HashMap<>();
        boolean showing = false;
        try {
            while (true) {
                Thread.sleep(500);
                List<Transfer> now;
                synchronized (this) {
                    now = new ArrayList<>(active);
                }
                if (now.isEmpty()) {
                    if (showing) System.out.print("\r" + pad(110) + "\r");
                    showing = false;
                    last.clear();
                    continue;
                }
                StringBuilder line = new StringBuilder("\r  sending ");
                for (Transfer t : now) {
                    long done = t.progress().done(), before = last.getOrDefault(t, done);
                    last.put(t, done);
                    double perSecond = (done - before) * 2.0; // sampled every 0.5 s
                    String name = t.payload().name().length() > 18 ? t.payload().name().substring(0, 16) + ".." : t.payload().name();
                    line.append(name).append(' ').append(t.progress().percent()).append("% ")
                            .append(String.format(Locale.ROOT, "%.1f MB/s", perSecond / 1e6));
                    if (perSecond > 0) line.append(", ").append(Texts.duration((long) ((t.progress().total() - done) / perSecond))).append(" left");
                    line.append("  ");
                }
                last.keySet().retainAll(now);
                String text = line.length() > 110 ? line.substring(0, 108) + ".." : line.toString();
                System.out.print(text + pad(111 - text.length()));
                showing = true;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
