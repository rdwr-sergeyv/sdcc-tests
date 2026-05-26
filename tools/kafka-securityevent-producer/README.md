# kafka-securityevent-producer

A lab tool that sends synthetic DefensePro security-event messages to Kafka in
the exact binary format that `attack-service` (sdcc-services) expects.

Useful for testing the attack-service pipeline without a real DefensePro device.

---

## How it works

Messages are serialized using **Kryo 5.4.0** (`writeClassAndObject`) with the
same class names and field layout as the production `KValue` / `KKey` types in
`sdcc-services/common-utils`. The key and value are raw binary — no JSON, no
Base64. Optional **XZ level-1 compression** is supported but off by default
(the attack-service consumer has `compress.fallback=true` so either works).

The payload is pre-populated with values that pass the `default_customer` filter
defined in `attack-default-lab20.properties`:

| Filter requirement | Default value |
|---|---|
| `action ≠ Forward` | `Drop` |
| `collectorType = CUSTOMER` | `CUSTOMER` |
| `vectorId` in 70–92 | `80` (TCP Scan) |
| `packetCount ≠ 0` | `1000` |

After a message is sent, the attack-service aggregates it in a **1-minute
tumbling window**. Allow up to ~2 minutes before checking MongoDB's `attack`
collection for a result.

---

## Prerequisites

**Docker** is the only hard requirement — no local Java or Gradle needed.

On first run the script builds a fat JAR using `gradle:8.4-jdk11` (~150 MB
download, cached in a Docker volume). Every subsequent run executes the
pre-built JAR with `eclipse-temurin:11-jre-alpine` and starts in ~2 seconds.

### Kafka hostname resolution

The lab Kafka container (`kafkaQA`) advertises itself as `kafka` internally.
Both names need to resolve on the VM host. Add them to `/etc/hosts` once:

```bash
echo "127.0.0.1 kafkaQA" | sudo tee -a /etc/hosts
echo "127.0.0.1 kafka"   | sudo tee -a /etc/hosts
```

---

## Quick start

```bash
cd sdcc-tests/tools/kafka-securityevent-producer

# Send one message with defaults
bash ./run.sh --bootstrap kafkaQA:9092
```

Expected output:

```
bootstrap : kafkaQA:9092
topic     : sdcc-mitigation-vision-defensepro-securityevents
accountId : 5eb04bc6af93511527471000
assetId   : 507f1f77bcf86cd799439011
count     : 1
compress  : false (XZ level-1)
[1/1] sent → partition=0 offset=3 timestamp=1779802497515
```

---

## Options

| Flag | Description |
|---|---|
| `--bootstrap <host:port>` | Kafka bootstrap server. Default: `localhost:9092` |
| `--topic <name>` | Topic to produce to. Default: `sdcc-mitigation-vision-defensepro-securityevents` |
| `--account-id <hex>` | Sets `accountId` in the payload. Default: `5eb04bc6af93511527471000` |
| `--asset-id <hex>` | Sets `assetId` in the payload. Default: `507f1f77bcf86cd799439011` |
| `--count <n>` | Number of messages to send. Default: `1` |
| `--field key=value` | Override or add any payload field. Repeatable. See type inference below. |
| `--props <file>` | Load settings and field overrides from a properties file. CLI flags win over file values. |
| `--compress` | Wrap the Kryo bytes in XZ level-1 compression. |
| `--dry-run` | Serialize and print hex bytes without connecting to Kafka. |
| `--list-fields` | Print all default payload field names and their types, then exit. |
| `--rebuild` | Force a JAR rebuild even if one already exists. |
| `--docker-network <name>` | Docker network to join when running via Docker. Default: `host`. |

### Type inference for `--field` and properties files

| Value format | Java type |
|---|---|
| `123` | `Integer` |
| `123L` | `Long` |
| `true` / `false` | `Boolean` |
| anything else | `String` |

Use `Long` for timestamps and rate fields: `startTimestamp=1748901600000L`.

---

## Examples

```bash
# Discover all available payload fields and their default values
bash ./run.sh --list-fields

# Override specific fields
bash ./run.sh --bootstrap kafkaQA:9092 \
  --field accountId=5eb04bc6af93511527471001 \
  --field assetId=507f1f77bcf86cd799439022  \
  --field vectorId=91                        \
  --field packetCount=5000L                  \
  --field status=Ended                       \
  --field risk=Low

# Send a burst of 10 messages
bash ./run.sh --bootstrap kafkaQA:9092 --count 10

# Use a scenario properties file (see example.properties)
bash ./run.sh --bootstrap kafkaQA:9092 --props my-scenario.properties

# Override one field on top of a properties file
bash ./run.sh --bootstrap kafkaQA:9092 --props my-scenario.properties \
  --field vectorId=75

# Dry-run: check serialization without sending
bash ./run.sh --dry-run

# Rebuild the fat JAR after editing source
bash ./run.sh --rebuild
```

---

## Scenario properties files

Copy `example.properties`, edit it for your scenario, and pass it with
`--props`. Any key not reserved for producer settings becomes a payload field
override. CLI flags always override file values.

Reserved producer keys: `bootstrap`, `topic`, `account-id`, `asset-id`,
`count`, `compress`, `dry-run`.

```bash
cp example.properties scenario-high-risk.properties
# edit scenario-high-risk.properties …
bash ./run.sh --bootstrap kafkaQA:9092 --props scenario-high-risk.properties
```

---

## After sending

Check whether attack-service processed the message:

```bash
# Tail attack-service logs for aggregator trace lines (appear immediately on receipt)
docker logs attackQA --follow | grep -i "aggregator\|attack-calculator"

# After ~2 minutes, check MongoDB for a new attack document
docker exec -it <mongo-container> mongosh attack \
  --eval 'db.attacks.find({assetId:"507f1f77bcf86cd799439011"}).sort({_id:-1}).limit(1).pretty()'
```

---

## Source layout

```
kafka-securityevent-producer/
  run.sh                         ← entry point
  build.gradle                   ← Gradle build (shadow JAR)
  settings.gradle
  example.properties             ← template for scenario files
  src/main/
    java/
      com/securitydam/sdcc/common/utils/kafka/
        KObject.java             ← stub (must match sdcc-services exactly)
        KProperties.java         ← stub
        KValue.java              ← stub
        KKey.java                ← stub
      com/securitydam/sdcc/tools/kafka/
        SecurityEventProducer.java   ← main class
    resources/
      simplelogger.properties    ← suppresses Kafka client INFO noise
```

The `KObject` / `KProperties` / `KValue` / `KKey` stubs use the same
fully-qualified package names and field declarations as the originals in
`sdcc-services`. Kryo embeds the class name in the binary, so the names must
match for the consumer to deserialize correctly. The stubs have no extra
instance fields — only the `protected Map<String, Object> properties` that
Kryo serializes.
