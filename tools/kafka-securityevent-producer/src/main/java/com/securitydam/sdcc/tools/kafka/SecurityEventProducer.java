package com.securitydam.sdcc.tools.kafka;

import com.esotericsoftware.kryo.Kryo;
import com.esotericsoftware.kryo.io.Output;
import com.esotericsoftware.kryo.util.DefaultInstantiatorStrategy;
import com.securitydam.sdcc.common.utils.kafka.KKey;
import com.securitydam.sdcc.common.utils.kafka.KValue;
import org.apache.commons.compress.compressors.xz.XZCompressorOutputStream;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import org.objenesis.strategy.StdInstantiatorStrategy;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.Future;

/**
 * Sends synthetic DefensePro security-event messages to Kafka using the exact
 * binary format that attack-service (sdcc-services) expects:
 *
 *   Kryo 5.4.0  writeClassAndObject(KKey)   → key bytes
 *   Kryo 5.4.0  writeClassAndObject(KValue) → value bytes
 *   optionally wrapped in XZ level-1 compression
 *
 * The class stubs (KObject / KProperties / KValue / KKey) use the same fully-
 * qualified names and field declarations as the originals so Kryo writes the
 * right class tags and field layout.
 *
 * Filter requirements (from attack-default-lab20.properties, default_customer):
 *   action      ≠ "Forward"   → use "Drop"
 *   collectorType = "CUSTOMER"
 *   vectorId    in 70-92      → default 80 ("TCP Scan")
 *   packetCount ≠ 0           → default 1000
 *
 * Usage:
 *   ./run.sh [OPTIONS]
 *
 * Options:
 *   --props   <file>       Load producer settings and payload overrides from a
 *                          .properties / .env file (see example.properties).
 *                          CLI flags always win over file values.
 *   --bootstrap <host:port>  Kafka bootstrap (default: localhost:9092)
 *   --topic     <name>       Topic (default: sdcc-mitigation-vision-defensepro-securityevents)
 *   --account-id <hex-oid>   accountId field (default: 5eb04bc6af93511527471000)
 *   --asset-id   <hex-oid>   assetId field   (default: 507f1f77bcf86cd799439011)
 *   --count      <n>         number of messages to send (default: 1)
 *   --field key=value        override or add any payload field; repeatable.
 *                            Type inference: "123L" → Long, "123" → Integer,
 *                            "true"/"false" → Boolean, anything else → String.
 *   --compress               enable XZ level-1 compression (default: off)
 *   --dry-run                serialize and print hex, but do not send
 *   --list-fields            print all default field names and values, then exit
 *
 * Properties file keys:
 *   Producer settings use the same names as the CLI flags (without "--"):
 *     bootstrap, topic, account-id, asset-id, count, compress, dry-run
 *   Any other key is treated as a payload field override (same type inference).
 */
public class SecurityEventProducer
{
    // Default topic consumed by attack-service for DefensePro events.
    // Topic naming rule: "sdcc-" + source path joined with hyphens.
    // Source: "mitigation/vision/defensepro/securityevents"
    private static final String DEFAULT_TOPIC =
            "sdcc-mitigation-vision-defensepro-securityevents";

    public static void main(String[] args) throws Exception
    {
        // ------------------------------------------------------------------ //
        //  Parse arguments                                                     //
        //  Two-pass: first collect --props path, load the file, then apply    //
        //  CLI args on top (CLI always wins over file values).                 //
        // ------------------------------------------------------------------ //
        String bootstrap                    = "localhost:9092";
        String topic                        = DEFAULT_TOPIC;
        String accountId                    = "5eb04bc6af93511527471000";
        String assetId                      = "507f1f77bcf86cd799439011";
        int    count                        = 1;
        boolean compress                    = false;
        boolean dryRun                      = false;
        boolean listFields                  = false;
        Map<String, Object> fieldOverrides  = new LinkedHashMap<>();

        // Pass 1: find --props and load the file into baseline settings.
        for (int i = 0; i < args.length; i++)
        {
            if ("--props".equals(args[i]) && i + 1 < args.length)
            {
                String propsFile = args[++i];
                Properties p = loadPropsFile(propsFile);
                // Producer settings
                if (p.containsKey("bootstrap"))  bootstrap = p.getProperty("bootstrap");
                if (p.containsKey("topic"))       topic     = p.getProperty("topic");
                if (p.containsKey("account-id"))  accountId = p.getProperty("account-id");
                if (p.containsKey("asset-id"))    assetId   = p.getProperty("asset-id");
                if (p.containsKey("count"))       count     = Integer.parseInt(p.getProperty("count").trim());
                if (p.containsKey("compress"))    compress  = Boolean.parseBoolean(p.getProperty("compress").trim());
                if (p.containsKey("dry-run"))     dryRun    = Boolean.parseBoolean(p.getProperty("dry-run").trim());
                // Everything else → payload field override
                for (String key : p.stringPropertyNames())
                {
                    if (!isProducerKey(key))
                        fieldOverrides.put(key, parseFieldValue(p.getProperty(key).trim()));
                }
                System.out.printf("[props] loaded %d entries from %s%n", p.size(), propsFile);
            }
        }

        // Pass 2: CLI args override whatever the file set.
        for (int i = 0; i < args.length; i++)
        {
            switch (args[i])
            {
                case "--props":        i++; break;                             // already handled
                case "--bootstrap":    bootstrap   = args[++i]; break;
                case "--topic":        topic       = args[++i]; break;
                case "--account-id":   accountId   = args[++i]; break;
                case "--asset-id":     assetId     = args[++i]; break;
                case "--count":        count       = Integer.parseInt(args[++i]); break;
                case "--compress":     compress    = true;      break;
                case "--dry-run":      dryRun      = true;      break;
                case "--list-fields":  listFields  = true;      break;
                case "--field":
                    String pair = args[++i];
                    int eq = pair.indexOf('=');
                    if (eq < 1)
                    {
                        System.err.println("--field requires key=value, got: " + pair);
                        System.exit(1);
                    }
                    fieldOverrides.put(pair.substring(0, eq),
                                       parseFieldValue(pair.substring(eq + 1)));
                    break;
                default:
                    System.err.println("Unknown argument: " + args[i]);
                    printUsage();
                    System.exit(1);
            }
        }

        // --list-fields: show defaults and exit (useful to discover field names)
        if (listFields)
        {
            KValue sample = buildSecurityEvent(System.currentTimeMillis(), accountId, assetId);
            System.out.println("Default payload fields (override with --field key=value):");
            sample.properties.forEach((k, v) ->
                System.out.printf("  %-30s %s  (%s)%n", k, v, v.getClass().getSimpleName()));
            return;
        }

        System.out.printf("bootstrap : %s%n", bootstrap);
        System.out.printf("topic     : %s%n", topic);
        System.out.printf("accountId : %s%n", accountId);
        System.out.printf("assetId   : %s%n", assetId);
        System.out.printf("count     : %d%n", count);
        System.out.printf("compress  : %b (XZ level-1)%n", compress);
        if (!fieldOverrides.isEmpty())
        {
            System.out.println("overrides :");
            fieldOverrides.forEach((k, v) ->
                System.out.printf("  %-30s %s  (%s)%n", k, v, v.getClass().getSimpleName()));
        }
        System.out.println();

        // ------------------------------------------------------------------ //
        //  Kafka producer                                                      //
        // ------------------------------------------------------------------ //
        Properties producerProps = new Properties();
        producerProps.put("bootstrap.servers",  bootstrap);
        producerProps.put("key.serializer",   "org.apache.kafka.common.serialization.ByteArraySerializer");
        producerProps.put("value.serializer", "org.apache.kafka.common.serialization.ByteArraySerializer");
        producerProps.put("acks",  "all");
        producerProps.put("retries", "3");

        try (KafkaProducer<byte[], byte[]> producer = dryRun ? null : new KafkaProducer<>(producerProps))
        {
            for (int i = 0; i < count; i++)
            {
                long now = System.currentTimeMillis();

                // ----------------------------------------------------------
                //  Build KKey  (assetId only; attack-service re-keys anyway)
                // ----------------------------------------------------------
                KKey key = buildKey(assetId);

                // ----------------------------------------------------------
                //  Build KValue  (full DefensePro security-event payload)
                //  then apply any --field overrides on top of the defaults.
                // ----------------------------------------------------------
                KValue value = buildSecurityEvent(now, accountId, assetId);
                fieldOverrides.forEach((k, v) -> value.set(k, v));

                // ----------------------------------------------------------
                //  Serialize (Kryo writeClassAndObject, optional XZ wrap)
                // ----------------------------------------------------------
                byte[] keyBytes   = serialize(key,   compress);
                byte[] valueBytes = serialize(value, compress);

                if (dryRun)
                {
                    System.out.printf("[%d] key   (%4d bytes): %s%n", i + 1, keyBytes.length,   hex(keyBytes,   32));
                    System.out.printf("[%d] value (%4d bytes): %s%n", i + 1, valueBytes.length, hex(valueBytes, 64));
                    continue;
                }

                ProducerRecord<byte[], byte[]> record =
                        new ProducerRecord<>(topic, keyBytes, valueBytes);

                Future<RecordMetadata> future = producer.send(record);
                RecordMetadata meta = future.get();

                System.out.printf("[%d/%d] sent → partition=%d offset=%d timestamp=%d%n",
                        i + 1, count,
                        meta.partition(), meta.offset(), meta.timestamp());

                // Small delay between messages so the windowed aggregator
                // can distinguish them.
                if (count > 1 && i < count - 1)
                    Thread.sleep(100);
            }
        }
    }

    // ======================================================================== //
    //  Payload builder                                                           //
    // ======================================================================== //

    /**
     * Builds the KKey placed on the Kafka record.
     * The attack-service immediately re-keys to assetId via selectKey(), so
     * this key is consumed only by the initial stream reader.
     */
    private static KKey buildKey(String assetId)
    {
        KKey key = new KKey();
        key.set("assetId", assetId);
        return key;
    }

    /**
     * Builds a DefensePro security-event KValue that will pass the
     * attack-service's default_customer filter.
     *
     * Field set mirrors the test fixture in SecurityEventAttackInputHandlerTest
     * and the SecurityEvent interface constants from sdcc-services.
     *
     * Filter requirements (attack-default-lab20.properties):
     *   action       ≠ "Forward"   ← "Drop" ✓
     *   collectorType = "CUSTOMER"  ✓
     *   vectorId     in 70-92       ← 80 ("TCP Scan") ✓
     *   packetCount  ≠ 0            ← 1000 ✓
     */
    private static KValue buildSecurityEvent(long nowMs, String accountId, String assetId)
    {
        KValue v = new KValue();

        // --- Core Kafka message fields ---
        v.set("_timestamp", nowMs);
        v.set("_id",        "test-producer-" + UUID.randomUUID());

        // --- Identity ---
        v.set("accountId",          accountId);
        v.set("accountName",        "testAccount");
        v.set("assetId",            assetId);
        v.set("assetName",          "testAsset");
        v.set("siteId",             "test-site-id");
        v.set("siteName",           "testSite");
        v.set("scrubbingcenterId",  "2222");
        v.set("scrubbingcenterName","ASH");

        // --- Vision / device info ---
        v.set("visionAddress", "10.30.5.50");
        v.set("visionName",    "ASH-VCPE-50");
        v.set("deviceAddress", "1.1.1.1");

        // --- Collector / classification ---
        // collectorType must be "CUSTOMER" to match default_customer filter
        v.set("collectorType",        "CUSTOMER");
        v.set("classification",       "DDOS");
        v.set("securityEventsProvider","VISION");

        // --- Attack vector ---
        // vectorId 80 is in the allowed 70-92 range
        v.set("vectorId",   80);        // Integer — matches putInteger() in original
        v.set("vectorName", "TCP Scan");
        v.set("category",   "AntiScanning");
        v.set("rule",       "CLF");
        v.set("threatGroup","NetworkScansGroup");

        // --- Status / action ---
        // action must NOT be "Forward"
        v.set("status",    "Ongoing");
        v.set("action",    "Drop");
        v.set("risk",      "High");

        // --- Timing ---
        v.set("startTimestamp", nowMs - 60_000L);   // Long
        v.set("endTimestamp",   nowMs);              // Long
        v.set("duration",       60_000);             // Integer (millis)

        // --- Traffic ---
        // packetCount must be non-zero to pass the filter
        v.set("packetCount",     1_000L);
        v.set("packetBandwidth", 1_000L);

        v.set("maxBitRate",    10_000_000L);
        v.set("maxByteRate",   1_000_000_000L);
        v.set("maxPacketRate", 0);                  // Integer

        v.set("lastPeriodBitRate",    1_000_000_000L);
        v.set("lastPeriodByteRate",   1_000_000_000L);
        v.set("lastPeriodPacketRate", 0);           // Integer

        v.set("averageBitRate",    0);              // Integer
        v.set("averageByteRate",   0);              // Integer
        v.set("averagePacketRate", 0);              // Integer

        // --- Network ---
        v.set("protocol",      "TCP");
        v.set("direction",     "Unknown");
        v.set("sourceAddress", "1.1.1.2");
        v.set("sourceAddressValue", 16843010L);     // 1.1.1.2 as long
        v.set("sourcePort",    0);                  // Integer
        v.set("sourceMsisdn",  "N/A");
        v.set("sourceAsn",     398324);             // Integer
        v.set("sourceIsp",     "TestISP");
        v.set("sourceCountry", "United States");
        v.set("targetAddress", "Multiple");
        v.set("targetPort",    "Multiple");
        v.set("targetMsisdn",  "N/A");

        v.set("vlanTag",      "N/A");
        v.set("mplsRd",       "N/A");
        v.set("physicalPort", 0);                   // Integer
        v.set("packetType",   "V8");
        v.set("trapVersion",  "Regular");

        return v;
    }

    // ======================================================================== //
    //  Serialization helpers                                                    //
    // ======================================================================== //

    /**
     * Creates a Kryo instance configured identically to the production KryoPool
     * in sdcc-services common-utils:
     *   - registrationRequired = false  (writes full class names)
     *   - DefaultInstantiatorStrategy with StdInstantiatorStrategy fallback
     */
    private static Kryo createKryo()
    {
        Kryo kryo = new Kryo();
        kryo.setRegistrationRequired(false);
        kryo.setInstantiatorStrategy(
                new DefaultInstantiatorStrategy(new StdInstantiatorStrategy()));
        return kryo;
    }

    /**
     * Serializes {@code obj} using {@code kryo.writeClassAndObject},
     * optionally wrapping the output stream in XZ level-1 compression.
     *
     * This mirrors BinarySerializer.serialize() + getOutputStream() exactly.
     */
    private static byte[] serialize(Object obj, boolean compress) throws Exception
    {
        Kryo kryo = createKryo();
        ByteArrayOutputStream bstream = new ByteArrayOutputStream();

        if (compress)
        {
            // XZCompressorOutputStream level 1 — same as BinarySerializer
            try (XZCompressorOutputStream xzOut = new XZCompressorOutputStream(bstream, 1);
                 Output output = new Output(xzOut))
            {
                kryo.writeClassAndObject(output, obj);
            }
        }
        else
        {
            try (Output output = new Output(bstream))
            {
                kryo.writeClassAndObject(output, obj);
            }
        }

        return bstream.toByteArray();
    }

    // ======================================================================== //
    //  Utilities                                                                //
    // ======================================================================== //

    private static String hex(byte[] bytes, int maxBytes)
    {
        StringBuilder sb = new StringBuilder();
        int limit = Math.min(bytes.length, maxBytes);
        for (int i = 0; i < limit; i++)
            sb.append(String.format("%02x", bytes[i]));
        if (bytes.length > maxBytes)
            sb.append("…");
        return sb.toString();
    }

    // ======================================================================== //
    //  Field value parser                                                      //
    // ======================================================================== //

    /**
     * Infers the Java type from the string representation so the KValue
     * properties map gets the right types (matching what putInteger/putLong/
     * putString/putBoolean would produce in the original code):
     *
     *   "123L"  or "123l"  → Long
     *   "123"              → Integer
     *   "true" / "false"   → Boolean
     *   anything else      → String
     *
     * Examples:
     *   packetCount=5000        → Integer(5000)
     *   packetCount=5000L       → Long(5000)
     *   startTimestamp=1748901600000L → Long(1748901600000)
     *   status=Ended            → String("Ended")
     *   vectorId=91             → Integer(91)
     */
    private static Object parseFieldValue(String raw)
    {
        if (raw.equalsIgnoreCase("true"))  return Boolean.TRUE;
        if (raw.equalsIgnoreCase("false")) return Boolean.FALSE;
        if (raw.endsWith("L") || raw.endsWith("l"))
        {
            try { return Long.parseLong(raw.substring(0, raw.length() - 1)); }
            catch (NumberFormatException ignored) {}
        }
        try { return Integer.parseInt(raw); }
        catch (NumberFormatException ignored) {}
        return raw;  // String
    }

    // ======================================================================== //
    //  Properties file support                                                 //
    // ======================================================================== //

    /** Keys that map to producer/runner settings rather than payload fields. */
    private static final java.util.Set<String> PRODUCER_KEYS = new java.util.HashSet<>(
            java.util.Arrays.asList(
                    "bootstrap", "topic", "account-id", "asset-id",
                    "count", "compress", "dry-run"));

    private static boolean isProducerKey(String key)
    {
        return PRODUCER_KEYS.contains(key);
    }

    /**
     * Loads a .properties / .env file.  Supports:
     *   - key=value  (standard Java Properties format)
     *   - # comment lines
     *   - blank lines
     *   - leading/trailing whitespace around keys and values
     *
     * Does NOT support multi-line values or quoted strings —
     * keep values on a single line.
     */
    private static Properties loadPropsFile(String path) throws IOException
    {
        Properties p = new Properties();
        try (InputStreamReader reader = new InputStreamReader(
                new FileInputStream(path), StandardCharsets.UTF_8))
        {
            p.load(reader);
        }
        return p;
    }

    private static void printUsage()
    {
        System.err.println(
            "Usage: ./run.sh [--props file] [--bootstrap host:port] [--topic name]\n" +
            "                [--account-id hex] [--asset-id hex]\n" +
            "                [--count n] [--field key=value]...\n" +
            "                [--compress] [--dry-run] [--list-fields]"
        );
    }
}
