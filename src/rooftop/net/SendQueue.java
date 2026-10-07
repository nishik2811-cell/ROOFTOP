package rooftop.net;

import java.io.IOException;
import java.util.Comparator;
import java.util.LinkedList;
import rooftop.Rooftop;
import rooftop.error.RooftopException;
import rooftop.model.Transfer;
import rooftop.util.Texts;
import rooftop.util.Threads;

/**
 * Producer/consumer. The shell thread submits transfers, one sender thread delivers them.
 * Inter-thread communication is plain wait() / notifyAll() on this object's monitor.
 */
public class SendQueue implements Runnable {
    private final LinkedList<Transfer> queue = new LinkedList<>();
    private final Rooftop app;

    public SendQueue(Rooftop app) {
        this.app = app;
    }

    /** Producer side. Smallest payloads first, so a quick text never waits behind a movie. */
    public synchronized void submit(Transfer transfer) {
        queue.add(transfer);
        queue.sort(Comparator.comparing(Transfer::payload));
        notifyAll();
    }

    /** Consumer side: sleeps in wait() until submit() wakes it. */
    private synchronized Transfer take() throws InterruptedException {
        while (queue.isEmpty()) wait();
        return queue.removeFirst();
    }

    @Override
    public void run() {
        try {
            while (true) deliver(take());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static final int ATTEMPTS = 3;

    /** Network errors are retried (each retry resumes where the last one stopped); a refusal is not. */
    private void deliver(Transfer t) throws InterruptedException {
        String label = t.payload().describe() + " -> " + t.target().name() + " ";
        String failure = null;
        for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
            Transfer tryThis = attempt == 1 ? t : t.retry();
            Thread meter = Threads.daemon("progress", () -> showProgress(tryThis, label));
            try {
                TransferClient.send(tryThis);
                failure = null;
                t = tryThis;
                break;
            } catch (RooftopException e) {
                failure = e.getMessage();
                break;
            } catch (IOException e) {
                failure = e.getMessage();
                if (attempt < ATTEMPTS) app.log().add("send to " + t.target().name() + " failed (" + failure + "), retrying " + (attempt + 1) + "/" + ATTEMPTS);
            } finally {
                meter.interrupt();
                meter.join(); // wait for the meter to print its last line before we log
            }
            if (attempt < ATTEMPTS) Thread.sleep(1000L * attempt); // 1 s, then 2 s: give the Wi-Fi a moment
        }
        app.log().add(failure == null ? "sent " + t.payload().describe() + " to " + t.target().name() + ", " + t.speed()
                : "could not send to " + t.target().name() + ": " + failure);
    }

    private static void showProgress(Transfer t, String label) {
        try {
            while (true) {
                System.out.print("\r" + label + Texts.bar(t.progress().percent(), 24));
                Thread.sleep(200);
            }
        } catch (InterruptedException e) {
            System.out.println("\r" + label + Texts.bar(t.progress().percent(), 24));
        }
    }
}
