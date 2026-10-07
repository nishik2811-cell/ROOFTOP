package rooftop.util;

public final class Threads {
    private Threads() {
    }

    /** Background threads never keep the JVM alive on their own. */
    public static Thread daemon(String name, Runnable task) {
        Thread t = new Thread(task, name);
        t.setDaemon(true);
        t.start();
        return t;
    }
}
