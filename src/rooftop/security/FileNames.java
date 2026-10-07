package rooftop.security;

import rooftop.error.InvalidFileNameException;

/** File names arrive from other devices, so they are cleaned before they ever touch the disk. */
public final class FileNames {
    private static final int MAX_LENGTH = 200;

    private FileNames() {
    }

    /** Keeps only the last path segment so "../../.bashrc" can never escape the inbox folder. */
    public static String clean(String raw) {
        if (raw == null) throw new InvalidFileNameException("missing file name");
        String name = raw.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).trim();
        name = name.replaceAll("[:*?\"<>|]", "_"); // characters Windows refuses in file names
        if (name.isEmpty() || name.equals(".") || name.equals("..") || name.endsWith(".part")
                || name.length() > MAX_LENGTH || name.chars().anyMatch(c -> c < 32))
            throw new InvalidFileNameException("bad file name: " + raw);
        return name;
    }

    public static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1) : "";
    }

    /** withSuffix("photo.jpg", " (2)") is "photo (2).jpg". */
    public static String withSuffix(String name, String suffix) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) + suffix + name.substring(dot) : name + suffix;
    }
}
