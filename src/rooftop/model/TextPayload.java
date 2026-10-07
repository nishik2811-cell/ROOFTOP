package rooftop.model;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class TextPayload extends Payload {
    private final byte[] bytes;

    public TextPayload(String text) {
        this.bytes = text.getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public String name() {
        return "message";
    }

    @Override
    public long size() {
        return bytes.length;
    }

    @Override
    public InputStream open() {
        return new ByteArrayInputStream(bytes);
    }

    @Override
    public String wireType() {
        return TEXT;
    }
}
