package rooftop.model;

/** Written by the sending thread, read by the progress-printing thread, so every access is synchronized. */
public class Progress {
    private final long total;
    private long done;

    public Progress(long total) {
        this.total = total;
    }

    public synchronized void add(long bytes) {
        done += bytes;
    }

    public synchronized int percent() {
        return total == 0 ? 100 : (int) (done * 100 / total);
    }
}
