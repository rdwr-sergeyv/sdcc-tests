#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run.sh — send a synthetic DefensePro security-event message to Kafka
#
# Docker is the primary (and easiest) way to run this — no local Java or
# Gradle installation required.  Native java+gradle is used only when both
# are already on PATH.
#
# NETWORKING
#   kafkaQA:9092  resolves only inside the Docker "lab" network.
#   From the VM host the exposed port is reachable as localhost:9092.
#   Pick the right --bootstrap value depending on where you run:
#
#     VM host (no Docker):         --bootstrap localhost:9092    ← default
#     Docker, lab network:         --bootstrap kafkaQA:9092
#
#   run.sh has a --docker-network flag to join any named Docker network:
#     ./run.sh --docker-network lab --bootstrap kafkaQA:9092
#
# EXAMPLES
#   # simplest — one message, localhost:9092
#   ./run.sh
#
#   # join the lab Docker network so kafkaQA resolves
#   ./run.sh --docker-network lab --bootstrap kafkaQA:9092
#
#   # send 5 messages with explicit IDs
#   ./run.sh --docker-network lab --bootstrap kafkaQA:9092 \
#            --account-id 5eb04bc6af93511527471000  \
#            --asset-id   507f1f77bcf86cd799439011  \
#            --count 5
#
#   # dry-run: serialize and print hex bytes without sending
#   ./run.sh --dry-run
#
#   # XZ compression (consumer has fallback so uncompressed is fine too)
#   ./run.sh --compress
#
# GRADLE DEPENDENCY CACHE
#   Docker downloads Gradle dependencies on the first run and stores them in
#   a named volume (kafka-producer-gradle-cache).  Subsequent runs are fast.
# ---------------------------------------------------------------------------
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Strip --docker-network <name> from $@ before forwarding args to the producer.
# Everything else is passed through to SecurityEventProducer.
# ---------------------------------------------------------------------------
DOCKER_NETWORK="host"   # default: host networking → localhost:9092 works
PRODUCER_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker-network)
            DOCKER_NETWORK="$2"; shift 2 ;;
        *)
            PRODUCER_ARGS+=("$1"); shift ;;
    esac
done

# ---------------------------------------------------------------------------
run_native() {
    cd "$DIR"
    gradle run --quiet --args="${PRODUCER_ARGS[*]:-}"
}

run_docker() {
    echo "[run.sh] running via Docker (gradle:8.4-jdk11, network=${DOCKER_NETWORK})"
    echo "[run.sh] first run downloads ~150 MB of Gradle deps into volume 'kafka-producer-gradle-cache'"

    # Named volume keeps the Gradle cache across runs — avoids re-downloading.
    docker run --rm \
        --network "$DOCKER_NETWORK" \
        -v "$DIR:/project" \
        -v "kafka-producer-gradle-cache:/root/.gradle" \
        -w /project \
        gradle:8.4-jdk11 \
        gradle run --quiet --console=plain \
        ${PRODUCER_ARGS:+--args="${PRODUCER_ARGS[*]}"}
}

# ---------------------------------------------------------------------------
if command -v gradle &>/dev/null && command -v java &>/dev/null; then
    echo "[run.sh] using native gradle + java"
    run_native
elif command -v docker &>/dev/null; then
    run_docker
else
    echo "ERROR: neither (gradle + java) nor docker found on PATH." >&2
    echo "Install Docker (https://docs.docker.com/engine/install/) and retry." >&2
    exit 1
fi
