# Bitcoin Core from the official release tarball, for deploy/docker/docker-compose.yml.
#
#   docker build -f deploy/docker/bitcoind.Dockerfile \
#     --build-arg BITCOIN_VERSION=<version> --build-arg BITCOIN_SHA256=<sha256 of the tarball> deploy/docker
#
# Both arguments are required. Take the sha256 from the release's SHA256SUMS file after checking
# that file's signatures against builder keys you trust (https://bitcoincore.org/en/download/);
# the build refuses a tarball with another hash. BITCOIN_ARCH is x86_64-linux-gnu or aarch64-linux-gnu.
FROM debian:bookworm-slim AS fetch
ARG BITCOIN_VERSION
ARG BITCOIN_SHA256
ARG BITCOIN_ARCH=x86_64-linux-gnu
RUN test -n "$BITCOIN_VERSION" && test -n "$BITCOIN_SHA256" \
    || { echo "BITCOIN_VERSION and BITCOIN_SHA256 build arguments are required" >&2; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/bitcoin
RUN curl -fsSLo bitcoin.tar.gz "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-${BITCOIN_ARCH}.tar.gz" \
    && echo "${BITCOIN_SHA256}  bitcoin.tar.gz" | sha256sum -c - \
    && tar -xzf bitcoin.tar.gz --strip-components=1 \
    && install -m 0755 bin/bitcoind bin/bitcoin-cli /usr/local/bin/

FROM debian:bookworm-slim
# uid and gid 1000, the same as the node user of the Murkle image, so the indexer can read the
# RPC cookie from the shared volume (rpccookieperms=group).
RUN groupadd --gid 1000 bitcoin && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin bitcoin \
    && mkdir -p /data && chown bitcoin:bitcoin /data
COPY --from=fetch /usr/local/bin/bitcoind /usr/local/bin/bitcoin-cli /usr/local/bin/
USER bitcoin
VOLUME ["/data"]
ENTRYPOINT ["bitcoind", "-datadir=/data", "-printtoconsole"]
