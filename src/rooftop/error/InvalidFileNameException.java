package rooftop.error;

/** Unchecked: a bad name is a caller bug or hostile input, so it is not declared in every signature. */
public class InvalidFileNameException extends IllegalArgumentException {
    public InvalidFileNameException(String message) {
        super(message);
    }
}
