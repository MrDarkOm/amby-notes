# Sync server image (docs/sync-plan.md, Р11). Build from the sync/ directory:
#   docker build -f server/Dockerfile -t amby-sync-server sync/
# Two stages: the build tools stay in the first one, the image that runs holds the binary only.
# The server runs as an ordinary user (uid 10001), keeps everything in the /data volume and is
# checked through /v1/info by `amby-sync-server healthcheck` (the image has no curl).

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY proto proto
COPY core core
COPY server server
COPY conformance conformance
COPY client client
RUN cargo build --release --locked -p amby-sync-server

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin amby \
 && mkdir /data \
 && chown amby /data
COPY --from=build /src/target/release/amby-sync-server /usr/local/bin/amby-sync-server
USER amby
ENV AMBY_SYNC_DATA_DIR=/data \
    AMBY_SYNC_LISTEN=0.0.0.0:8080
WORKDIR /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["amby-sync-server", "healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["amby-sync-server"]
CMD ["serve"]
