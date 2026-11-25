FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 ripgrep bubblewrap build-essential && rm -rf /var/lib/apt/lists/*
# Child Node processes with a minimal environment use the POSIX default PATH.
RUN ln -s /usr/local/bin/node /usr/bin/node
WORKDIR /opt/openstrudel
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
USER node
ENV HOME=/work
ENTRYPOINT ["node","--disable-warning=ExperimentalWarning","/opt/openstrudel/dist/project-worker-entry.js"]
