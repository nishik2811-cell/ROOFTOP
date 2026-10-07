package rooftop.model;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;

public class FilePayload extends Payload {
    private final Path path;
    private final long size;

    public FilePayload(Path path) throws IOException {
        if (!Files.isRegularFile(path)) throw new NoSuchFileException(path.toString());
        this.path = path;
        this.size = Files.size(path);
    }

    @Override
    public String name() {
        return path.getFileName().toString();
    }

    @Override
    public long size() {
        return size;
    }

    @Override
    public InputStream open() throws IOException {
        return Files.newInputStream(path);
    }

    /** Overrides Payload: an edited file with the same name and size must not resume onto old bytes. */
    @Override
    public String resumeKey() {
        try {
            return super.resumeKey() + "|" + Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return super.resumeKey();
        }
    }

    @Override
    public String wireType() {
        return FILE;
    }
}
