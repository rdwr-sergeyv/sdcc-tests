package com.securitydam.sdcc.common.utils.kafka;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Stub matching sdcc-services KProperties.
 * The single field `properties` must be declared with exactly the same name,
 * type and modifier as in the original — Kryo FieldSerializer uses field
 * declaration order for the binary layout.
 */
public abstract class KProperties<KPROPERTIES extends KProperties<?>> extends KObject
{
    // Field name, type, and access modifier must match the original exactly.
    protected Map<String, Object> properties = new LinkedHashMap<>();

    /** Convenience setter used by the producer. */
    @SuppressWarnings("unchecked")
    public KPROPERTIES set(String key, Object value)
    {
        properties.put(key, value);
        return (KPROPERTIES) this;
    }

    /** Exposes the properties map for inspection (e.g. --list-fields). */
    public Map<String, Object> getProperties()
    {
        return properties;
    }
}
