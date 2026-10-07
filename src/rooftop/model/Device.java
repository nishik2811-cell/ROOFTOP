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

    /** Short label for the radar and the phone page, e.g. "PC" or "PHONE". */
    public abstract String kind();

    @Override
    public String toString() {
        return kind() + " " + name;
    }
}
