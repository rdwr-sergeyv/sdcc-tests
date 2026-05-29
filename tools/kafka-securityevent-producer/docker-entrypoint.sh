#!/bin/sh
# Pass --bootstrap explicitly, or set KAFKA_BOOTSTRAP_SERVERS.
case " $* " in
  *" --bootstrap "*)
    exec java -jar /project/kafka-securityevent-producer.jar "$@"
    ;;
  *)
    if [ -n "${KAFKA_BOOTSTRAP_SERVERS:-}" ]; then
      exec java -jar /project/kafka-securityevent-producer.jar --bootstrap "$KAFKA_BOOTSTRAP_SERVERS" "$@"
    fi
    exec java -jar /project/kafka-securityevent-producer.jar "$@"
    ;;
esac
