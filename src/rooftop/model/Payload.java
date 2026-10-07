package rooftop.model;

/** Abstract base for the two things we send. Ordered by size so short texts never wait behind big files. */
public abstract class Payload implements Transferable, Comparable<Payload> {
    public static final String FILE = "FILE";
    public static final String TEXT = "TEXT";

    /** Identifies this exact content for resuming. Subclasses that know more (a file's last change) refine it. */
    public String resumeKey() {
        return name() + "|" + size();
    }

    /** Tag written on the wire so the receiver knows how to treat the bytes. */
    public abstract String wireType();

    @Override
    public int compareTo(Payload other) {
        return Long.compare(size(), other.size());
    }
}
