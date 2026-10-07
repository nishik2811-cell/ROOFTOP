package rooftop.model;

/** Root of the device hierarchy. Everything that shows up on the map has a name and a kind. */
public abstract class Device {
    private volatile String name;

    protected Device(String name) {
        this.name = name;
    }

    public String name() {
        return name;
    }

    /** Gives the device the name its owner picked. Returns false (and keeps the old one) if nothing usable is left. */
    public boolean rename(String wanted) {
        String clean = cleanName(wanted);
        if (clean == null) return false;
        name = clean;
        return true;
    }

    /** Up to 32 visible characters, single spaces, no control characters; null if that leaves nothing. */
    public static String cleanName(String wanted) {
        if (wanted == null) return null;
        String clean = wanted.replaceAll("[\\p{Cntrl}\\p{Cf}]", "").replaceAll("\\s+", " ").trim();
        if (clean.length() > 32) clean = clean.substring(0, 32).trim();
        return clean.isEmpty() ? null : clean;
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
