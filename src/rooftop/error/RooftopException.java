package rooftop.error;

/** Base checked exception for the app: the compiler forces callers to handle or declare it. */
public class RooftopException extends Exception {
    public RooftopException(String message) {
        super(message);
    }
}
