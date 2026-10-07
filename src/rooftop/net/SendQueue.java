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

    private void deliver(Transfer t) throws InterruptedException {
        String label = t.payload().describe() + " -> " + t.target().name() + " ";
        Thread meter = Threads.daemon("progress", () -> showProgress(t, label));
        String failure = null;
        try {
            TransferClient.send(t);
        } catch (IOException | RooftopException e) {
            failure = e.getMessage();
        } finally {
            meter.interrupt();
            meter.join(); // wait for the meter to print its last line before we log
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
