package rooftop.model;

/** Root of the device hierarchy. Everything that shows up on the map has a name and a kind. */
public abstract class Device {
    private final String name;

    protected Device(String name) {
        this.name = name;
    }

    public String name() {
        return name;
    }

    /** Stable id used to address files to this device. Names are for people; ids never change while it runs. */
    public String id() {
        return name;
    }

    private volatile String publicKey = ""; // the browser's end-to-end key (base64url), if it has one

    public String publicKey() {
        return publicKey;
    }

    /** A P-256 public key is 65 bytes, 87 characters of base64url. Anything else is ignored. */
    public void setPublicKey(String key) {
        if (key != null && key.matches("[A-Za-z0-9_-]{80,100}")) publicKey = key;
    }

    /** Short label for the radar and the phone page, e.g. "PC" or "PHONE". */
    public abstract String kind();

    @Override
    public String toString() {
        return kind() + " " + name;
    }
}
