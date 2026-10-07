package rooftop.model;

import java.io.IOException;
import java.io.InputStream;
import rooftop.util.Texts;

/** Anything that can be streamed to another device. */
public interface Transferable {
    String name();

    long size();

    InputStream open() throws IOException;

    default String describe() {
        return name() + " (" + Texts.humanSize(size()) + ")";
    }
}
