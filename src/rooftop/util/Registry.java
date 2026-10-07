package rooftop.util;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;
import rooftop.model.Device;

/** Thread-safe lookup table for devices. Bounded generic: it only ever stores Device subtypes. */
public class Registry<K, V extends Device> {
    private final Map<K, V> entries = new HashMap<>();

    public synchronized void put(K key, V value) {
        entries.put(key, value);
    }

    public synchronized Optional<V> find(K key) {
        return Optional.ofNullable(entries.get(key));
    }

    public synchronized V getOrAdd(K key, Supplier<? extends V> create) {
        return entries.computeIfAbsent(key, k -> create.get());
    }

    public synchronized List<V> all() {
        return new ArrayList<>(entries.values());
    }

    /** Drops every entry of one kind, e.g. all phones when a session ends. Returns how many went. */
    public synchronized int removeType(Class<? extends V> type) {
        int before = entries.size();
        entries.values().removeIf(type::isInstance);
        return before - entries.size();
    }

    /** Generic method: {@code ofType(PcPeer.class)} returns a List<PcPeer>, no casts at the call site. */
    public synchronized <T extends V> List<T> ofType(Class<T> type) {
        List<T> out = new ArrayList<>();
        for (V v : entries.values())
            if (type.isInstance(v)) out.add(type.cast(v));
        return out;
    }
}
