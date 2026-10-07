package rooftop.model;

import java.net.InetAddress;

/** Another PC running Rooftop. */
public class PcPeer extends NetworkDevice {
    public PcPeer(String name, InetAddress address) {
        super(name, address);
    }

    @Override
    public String kind() {
        return "PC";
    }
}
