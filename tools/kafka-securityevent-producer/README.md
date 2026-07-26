# kafka-securityevent-producer

A lab Kafka tool with **two halves**:

1. **Producer** (CLI, `run.sh`) — sends synthetic DefensePro security-event messages in the
   exact binary format that `attack-service` (sdcc-services) expects, so the attack pipeline
   can be exercised without a real DefensePro device.
2. **Observer** (web UI, `ui/`) — lists broker topics and live-streams messages off any topic,
   so you can watch what a service actually publishes. The UI presents itself as
   "⚡ Kafka Tool" with **Producer** and **Consumer** tabs.

The name predates the UI and undersells it: if you are here to *watch* a topic rather than
publish to one, see [Web UI](#web-ui--producer--observer) below.

> **Lab only.** Neither half supports SASL/SSL, so neither can talk to a Confluent cluster.
> See [Limitations](#limitations) before reaching for this against a real environment.

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

## Web UI — producer + observer

```bash
cd sdcc-tests/tools/kafka-securityevent-producer/ui
npm install        # first time only
npm start          # → http://localhost:3000  (PORT env var to change)
```

Two tabs:

- **Producer** — a form over the CLI. Bootstrap, topic, count, Docker network, compress, dry-run,
  plus per-field overrides. Submitting shells out to `run.sh`, so behaviour is identical to the
  command line.
- **Consumer** — the observer. Pick a bootstrap and topic, optionally a group id and
  "from beginning", then **Start**. Messages stream in live with auto-scroll.

### HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/fields` | default payload field names and types |
| `POST /api/send` | produce (shells out to `run.sh`) |
| `GET /api/topics` | list broker topics via the Kafka admin client; internal `__*` topics filtered out |
| `GET /api/consume` | **SSE stream** of messages. Query: `bootstrap`, `topic` (required), `fromBeginning`, `groupId` |

### What the observer shows

Each streamed message carries `topic`, `partition`, `offset`, `timestamp`, `valueSize`, and the
key and value as **hex** (`keyHex`, `valueHex`).

It does **not** decode the payload. Production messages are Kryo-serialised `KValue` objects, and
the consumer streams raw bytes, so you get proof that a message arrived — when, how large, on which
partition and offset — but not its fields. To read fields you either decode the hex yourself or
consume with something that has the `KValue` classes on its classpath.

### One safety property worth knowing

The consumer defaults its group id to `ui-consumer-<timestamp>` — **a fresh group per session**.
That means it does not join any service's consumer group and therefore cannot take partitions away
from a running consumer: observing is read-only in effect as well as intent. If you override
`groupId` with a real service's group, you lose that guarantee and will steal its partitions.

---

## Limitations

- **No SASL/SSL, in either half.** The Java producer sets no `security.protocol` and the UI builds
  its client as `new Kafka({ brokers: [bootstrap] })` with no `ssl` or `sasl` options. Both can
  therefore only reach a **plaintext** broker — the lab `kafkaQA`. Pointing either at a Confluent
  bootstrap (`SASL_SSL` + `PLAIN`) fails at the handshake. Making it usable against Confluent means
  adding `ssl: true` plus `sasl: { mechanism: 'plain', username, password }` to the UI client, and
  the equivalent three producer properties on the Java side.
- **The payload is security-event shaped.** `--topic` and `--field` let you publish to any topic
  with arbitrary fields, but the defaults and the `KValue` stubs are built around DefensePro
  security events. Producing a *different* message contract (for example pipeliner's on-demand
  statistics trigger, which wants accountId plus account and services JSON) means overriding every
  field by hand and checking the consumer accepts it.
- **The observer cannot decode.** See above — hex only.
- **No offset management or replay UI** beyond `fromBeginning`.

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
  ui/
    server.js                    ← Express app: /api/fields, /api/send, /api/topics, /api/consume
    package.json                 ← express + kafkajs
    public/index.html            ← "⚡ Kafka Tool" — Producer and Consumer tabs
  Dockerfile, docker-entrypoint.sh, .dockerignore
```

The `KObject` / `KProperties` / `KValue` / `KKey` stubs use the same
fully-qualified package names and field declarations as the originals in
`sdcc-services`. Kryo embeds the class name in the binary, so the names must
match for the consumer to deserialize correctly. The stubs have no extra
instance fields — only the `protected Map<String, Object> properties` that
Kryo serializes.
