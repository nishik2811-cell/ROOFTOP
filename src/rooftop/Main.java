package rooftop;

import java.nio.file.Paths;
import rooftop.cli.Shell;

/**
 * Desktop entry point. Run from the project folder (Java 22 or newer compiles the other files on the fly):
 *     java src/rooftop/Main.java
 */
public class Main {
    public static void main(String[] args) throws Exception {
        Rooftop app = new Rooftop(new DesktopPlatform(Paths.get(args.length > 0 ? args[0] : "web")));
        app.start();
        new Shell(app).run(System.in);
    }
}
