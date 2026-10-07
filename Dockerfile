# Murkle indexer: the API, the pinned artifacts and the built web app on one port (8787).
#
#   docker build -t murkle-indexer .                                   # signet (the default)
#   docker build -t murkle-indexer:mainnet --build-arg MURKLE_NETWORK=mainnet .
#   docker run -d --name murkle -p 8787:8787 -v murkle-data:/app/data \
#     -e MURKLE_ARTIFACTS_URL=https://<a Murkle site>/artifacts \
#     -e MURKLE_PUBLIC_URL=https://your.site murkle-indexer
#
# MURKLE_NETWORK (signet or mainnet) is fixed at build time: the web app bakes it in, and the
# image sets it for the server and the artifact check. Mainnet has not launched: a mainnet image
# refuses to start until the mainnet pins are complete (docs/MAINNET.md). A full deployment with
# Bitcoin Core, a reverse proxy and the optional ceremony coordinator is in deploy/docker.
#
# MURKLE_PUBLIC_URL is the public origin of the site. Link previews need it for absolute
# og:image and twitter:image URLs; without it pages get a plain card and the server warns at start.
#
# The pinned artifacts are fetched at build time when MURKLE_ARTIFACTS_URL is passed as a
# build argument, else at the first start from the MURKLE_ARTIFACTS_URL environment variable,
# and every file is checked against the network's pins (scripts/fetch-artifacts.mjs). Or mount
# a checked build/ directory read-only at /app/build.
#
# No keys or wallets are baked in (.dockerignore keeps data/, build/, *.key, recovery phrase and
# seed files, env files and backups out of the build context). The relayer is off: MURKLE_RELAYER=0.
# Chain state lives in the /app/data volume. The code is owned by root and read-only to the
# service user, which can write only /app/data and /app/build (the artifacts fetched at the first start).
#
# HEALTHCHECK is liveness only (/api/health answers 200 while the process serves): a halted
# relayer or a lagging indexer never restarts the container; deploy/bin/monitor.mjs reports them.

FROM node:22-alpine AS build
ARG MURKLE_NETWORK=signet
ENV MURKLE_NETWORK=$MURKLE_NETWORK
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG MURKLE_ARTIFACTS_URL=""
RUN if [ -n "$MURKLE_ARTIFACTS_URL" ]; then node scripts/fetch-artifacts.mjs --from "$MURKLE_ARTIFACTS_URL"; \
    else echo "No MURKLE_ARTIFACTS_URL build argument: the artifacts are fetched when the container starts."; fi
# The site's facts (constraint count, artifact hashes) come from build/; without the artifacts
# here they show as unknown, which is honest, until the image is rebuilt with them.
RUN npm run web:build && npm prune --omit=dev

FROM node:22-alpine
ARG MURKLE_NETWORK=signet
ENV NODE_ENV=production \
    MURKLE_NETWORK=$MURKLE_NETWORK \
    MURKLE_RELAYER=0 \
    MURKLE_INDEXER_PORT=8787
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/data /app/build && chown -R node:node /app/data /app/build
USER node
VOLUME ["/app/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "const p=process.env.MURKLE_INDEXER_PORT||8787;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>r.status===200?0:r.status===404?fetch('http://127.0.0.1:'+p+'/api/state').then(s=>s.ok?0:1):1,()=>1).then(c=>process.exit(c),()=>process.exit(1))"
CMD ["sh", "-c", "node scripts/fetch-artifacts.mjs --check --quiet || node scripts/fetch-artifacts.mjs || exit 1; exec node server/indexer-server.mjs"]
