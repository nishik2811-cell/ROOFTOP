package rooftop.model;

/** Single inheritance: the computer Rooftop is running on. */
public class ThisDevice extends Device {
    public ThisDevice(String name) {
        super(name);
    }

    public static final String ID = "host";

    @Override
    public String id() {
        return ID;
    }

    @Override
    public String kind() {
        return "THIS PC";
    }
}
