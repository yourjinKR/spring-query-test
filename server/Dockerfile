FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml ./
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn --batch-mode --no-transfer-progress -DskipTests package

FROM eclipse-temurin:21-jre-jammy
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system querylab \
    && useradd --system --gid querylab --home-dir /app querylab
WORKDIR /app
COPY --from=build --chown=querylab:querylab /workspace/target/*.jar ./app.jar
USER querylab
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
