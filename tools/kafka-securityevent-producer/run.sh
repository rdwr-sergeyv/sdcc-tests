#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run.sh — send a synthetic DefensePro security-event message to Kafka
#
# HOW IT WORKS
#   First run:  builds a self-contained fat JAR using gradle:8.4-jdk11.
#               Downloads ~150 MB of dependencies once, then never again.
#   Every run:  executes the pre-built JAR with eclipse-temurin:11-jre-alpine
#               (~80 MB image, starts in ~2 s, no Gradle overhead).
#
#   Use --rebuild to force a JAR rebuild (e.g. after editing source).
#
# NETWORKING
#   kafkaQA:9092 resolves only inside the Docker "lab" network.
#   From the VM host, the exposed port is reachable as localhost:9092 — but
#   Kafka advertises kafkaQA:9092 as its listener, so the producer will hang
#   after the bootstrap handshake.  Always use --docker-network lab in the lab:
#
#     bash ./run.sh --docker-network lab --bootstrap kafkaQA:9092 [OPTIONS]
#
# EXAMPLES
#   # build JAR and send one message
#   bash ./run.sh --docker-network lab --bootstrap kafkaQA:9092
#
#   # send 5 messages with field overrides
#   bash ./run.sh --docker-network lab --bootstrap kafkaQA:9092 \
#            --field accountId=5eb04bc6af93511527471001 \
#            --field assetId=507f1f77bcf86cd799439022  \
#            --field vectorId=91 --field packetCount=5000L --count 5
#
#   # use a scenario properties file
#   bash ./run.sh --docker-network lab --props lab.properties
#
#   # dry-run (no Kafka needed)
#   bash ./run.sh --dry-run
#
#   # force JAR rebuild after source changes
#   bash ./run.sh --rebuild
# ---------------------------------------------------------------------------
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="$DIR/build/libs/kafka-securityevent-producer.jar"

# ---------------------------------------------------------------------------
# Strip run.sh-only flags before forwarding the rest to SecurityEventProducer.
# ---------------------------------------------------------------------------
DOCKER_NETWORK="host"
REBUILD=false
PRODUCER_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker-network) DOCKER_NETWORK="$2"; shift 2 ;;
        --rebuild)        REBUILD=true;        shift   ;;
        *)                PRODUCER_ARGS+=("$1"); shift  ;;
    esac
done

# ---------------------------------------------------------------------------
# build_jar — runs once (or when --rebuild is passed).
# Uses the heavy gradle image; result lands in ./build/libs/.
# ---------------------------------------------------------------------------
build_jar() {
    echo "[run.sh] building fat JAR (this downloads ~150 MB of deps on first build)..."
    docker run --rm \
        -v "$DIR:/project" \
        -v "kafka-producer-gradle-cache:/root/.gradle" \
        -w /project \
        gradle:8.4-jdk11 \
        gradle shadowJar --quiet --console=plain
    echo "[run.sh] JAR built: $JAR"
}

# ---------------------------------------------------------------------------
# run_jar — fast path used on every invocation after the JAR exists.
# eclipse-temurin:11-jre-alpine is ~80 MB and has no Gradle overhead.
# ---------------------------------------------------------------------------
run_jar() {
    docker run --rm \
        --network "$DOCKER_NETWORK" \
        -v "$DIR:/project" \
        -w /project \
        eclipse-temurin:11-jre-alpine \
        java -jar /project/build/libs/kafka-securityevent-producer.jar \
        "${PRODUCER_ARGS[@]+"${PRODUCER_ARGS[@]}"}"
}

# ---------------------------------------------------------------------------
run_native() {
    cd "$DIR"
    gradle shadowJar --quiet
    java -jar "$JAR" "${PRODUCER_ARGS[@]+"${PRODUCER_ARGS[@]}"}"
}

# ---------------------------------------------------------------------------
if command -v gradle &>/dev/null && command -v java &>/dev/null; then
    echo "[run.sh] using native gradle + java"
    run_native
elif command -v docker &>/dev/null; then
    if $REBUILD || [[ ! -f "$JAR" ]]; then
        build_jar
    fi
    run_jar
else
    echo "ERROR: neither (gradle + java) nor docker found on PATH." >&2
    echo "Install Docker (https://docs.docker.com/engine/install/) and retry." >&2
    exit 1
fi
