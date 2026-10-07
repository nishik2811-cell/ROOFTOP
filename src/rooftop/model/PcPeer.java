package rooftop.model;

import java.net.InetAddress;

/** Another PC running Rooftop. */
public class PcPeer extends NetworkDevice {
    private volatile boolean frames;

    public PcPeer(String name, InetAddress address) {
        super(name, address);
    }

    /** True once this PC has said it can take compressed transfers. */
    public boolean takesFrames() {
        return frames;
    }

    public void setTakesFrames() {
        frames = true;
    }

    @Override
    public String kind() {
        return "PC";
    }
}
