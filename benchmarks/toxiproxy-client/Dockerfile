FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml ./
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn --batch-mode --no-transfer-progress verify

FROM eclipse-temurin:21-jre-jammy
RUN groupadd --system querylab && useradd --system --gid querylab --home-dir /app querylab
WORKDIR /app
COPY --from=build --chown=querylab:querylab /workspace/target/latency-control.jar ./app.jar
USER querylab
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
