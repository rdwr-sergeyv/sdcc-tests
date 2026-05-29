FROM gradle:8.4-jdk11 AS builder
WORKDIR /project
COPY --chown=gradle:gradle . .
RUN gradle shadowJar --no-daemon --quiet --console=plain

FROM eclipse-temurin:11-jre-alpine
WORKDIR /project
COPY --from=builder /project/build/libs/kafka-securityevent-producer.jar .
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
