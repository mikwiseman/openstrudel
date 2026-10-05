FROM node:24.13.0-bookworm-slim AS build
WORKDIR /opt/openstrudel
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

# Official whisper.cpp v1.9.4, built for the image architecture (no native CPU flags).
# Source: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.4
# The multilingual model is the upstream conversion linked from models/README.md.
FROM node:24.13.0-bookworm-slim AS speech-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl cmake build-essential pkg-config libopenblas-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fL --retry 3 --connect-timeout 30 --max-time 300 \
      https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/927cfce34f31707e17f2bff35c349632fb9e2c3a -o whisper.tar.gz \
    && echo '41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde  whisper.tar.gz' | sha256sum -c - \
    && mkdir whisper.cpp && tar -xzf whisper.tar.gz -C whisper.cpp --strip-components=1 \
    && cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_CURL=OFF \
    && cmake --build whisper.cpp/build --config Release --target whisper-cli -j 2
RUN mkdir /build/models \
    && curl -fL --retry 3 --connect-timeout 30 --max-time 600 \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin \
      -o /build/models/ggml-large-v3-turbo-q5_0.bin \
    && echo '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2  /build/models/ggml-large-v3-turbo-q5_0.bin' | sha256sum -c -
RUN curl -fL --retry 3 --connect-timeout 30 --max-time 60 \
      https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE -o /build/models/LICENSE \
    && echo 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d  /build/models/LICENSE' | sha256sum -c -

FROM node:24.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl git curl ripgrep python3 bubblewrap ffmpeg libopenblas0-pthread \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/openstrudel /opt/openstrudel
COPY --from=speech-build /build/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=speech-build /build/whisper.cpp/LICENSE /usr/local/share/licenses/whisper.cpp/LICENSE
COPY --from=speech-build /build/models/LICENSE /usr/local/share/licenses/whisper-model/LICENSE
COPY --from=speech-build /build/models/ggml-large-v3-turbo-q5_0.bin /opt/openstrudel/voice/ggml-large-v3-turbo-q5_0.bin
COPY scripts/container-start.sh /usr/local/bin/openstrudel-start
COPY scripts/check-sandbox.mjs /opt/openstrudel/scripts/check-sandbox.mjs
RUN chmod 755 /usr/local/bin/openstrudel-start && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production OPENSTRUDEL_DB=/data/.data/openstrudel.sqlite OPENSTRUDEL_CODEX_HOME=/data/.data/codex OPENSTRUDEL_SETUP_HOST=0.0.0.0
WORKDIR /data
VOLUME /data
USER node
EXPOSE 7789 8080
ENTRYPOINT ["openstrudel-start"]
