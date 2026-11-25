FROM eclipse-temurin:21-jdk-jammy AS java
FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git zip unzip python3 make g++ libfontconfig1 && rm -rf /var/lib/apt/lists/*
COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY deploy/project-worker/package.sh /usr/local/bin/wolf-package-build
ENV JAVA_HOME=/opt/java/openjdk ANDROID_HOME=/opt/android HOME=/work GRADLE_USER_HOME=/work/.gradle PATH=/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin
USER node
ENTRYPOINT ["/bin/sh","/usr/local/bin/wolf-package-build"]
