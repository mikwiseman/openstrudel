# linux/amd64 manifest verified from the official Node image on 2026-10-04.
FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS commonbase
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssh-client openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# A real sshd parser is required by the hardening regression tests only.
FROM commonbase AS verified
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server age \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node tests/ ./tests/
RUN node --test --test-concurrency=2 tests/*.test.mjs

FROM commonbase AS runtime
COPY --from=verified --chown=node:node /app/package.json ./
COPY --from=verified --chown=node:node /app/src/ ./src/
COPY --from=verified --chown=node:node /app/public/ ./public/
COPY --from=verified --chown=node:node /app/scripts/ ./scripts/
RUN test ! -e /usr/sbin/sshd \
    && mkdir -p /var/lib/wai-vds \
    && chown node:node /var/lib/wai-vds
ENV NODE_ENV=production
USER 1000:1000
RUN node --input-type=module -e "await import('./src/service.mjs'); const fs = await import('node:fs/promises'); await fs.readFile('./src/main.mjs'); await fs.readFile('./public/index.html'); await fs.readFile('./scripts/preflight.mjs');"
EXPOSE 4781
CMD ["node", "src/main.mjs"]
