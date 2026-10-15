# Murkle GPU miner: murkle-gpu and the CLI in one image (docs/design/mining.md section 12.2, gpu/README.md).
#
#   docker build -f gpu/Dockerfile -t murkle-gpu --build-arg MURKLE_NETWORK=mainnet \
#     --build-arg MURKLE_ARTIFACTS_URL=https://<a Murkle site>/artifacts .
#   docker run --gpus all -v murkle-data:/app/data murkle-gpu mine alice MURK --gpu all
#
# Build it from the repository root. MURKLE_NETWORK (signet or mainnet) is required: the build fails
# without it. The pinned proving artifacts are fetched at build time from MURKLE_ARTIFACTS_URL, as in
# the root Dockerfile, and checked against the network's pins; without the argument mount a checked
# build/ directory at /app/build. Wallets and the mining key live in the /app/data volume: use a
# separate mining wallet on a rented machine, fund its mining key with what you will spend, move the
# rewards out often (the provider can read the disk). The host needs an NVIDIA driver (525.60 or newer)
# and the NVIDIA Container Toolkit for --gpus. Publishing an image to a registry is the owner's step.

# ---- stage 1: compile murkle-gpu (no GPU needed)
FROM nvidia/cuda:12.8.1-devel-ubuntu24.04@sha256:520292dbb4f755fd360766059e62956e9379485d9e073bbd2f6e3c20c270ed66 AS build
ARG MURKLE_GPU_GIT=unknown
ENV MURKLE_GPU_GIT=$MURKLE_GPU_GIT
WORKDIR /src
COPY gpu ./gpu
RUN bash gpu/build.sh

# ---- stage 2: Node 22, the CLI and the binary
FROM nvidia/cuda:12.8.1-base-ubuntu24.04@sha256:133c78a0575303be34164d0b90137a042172bdf60696af01a3c424ab402d86e2
ARG MURKLE_NETWORK
RUN case "$MURKLE_NETWORK" in signet|mainnet) ;; *) echo "build with --build-arg MURKLE_NETWORK=signet or mainnet (it is required)" >&2; exit 1 ;; esac
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c - \
 && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
 && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /usr/sbin/nologin node
ENV NODE_ENV=production \
    MURKLE_NETWORK=$MURKLE_NETWORK \
    MURKLE_GPU_BIN=/app/gpu/bin/murkle-gpu-linux-x64 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
COPY --from=build /src/gpu/bin/murkle-gpu-linux-x64 /app/gpu/bin/murkle-gpu-linux-x64
ARG MURKLE_ARTIFACTS_URL=""
RUN if [ -n "$MURKLE_ARTIFACTS_URL" ]; then node scripts/fetch-artifacts.mjs --from "$MURKLE_ARTIFACTS_URL"; \
    else echo "No MURKLE_ARTIFACTS_URL build argument: mount a checked build/ directory at /app/build."; fi
RUN mkdir -p /app/data /app/build && chown -R node:node /app/data /app/build
USER node
VOLUME ["/app/data"]
ENTRYPOINT ["node", "bin/murkle.mjs"]
