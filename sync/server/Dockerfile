# Sync server image (docs/sync-plan.md, Р11). Build from the sync/ directory:
#   docker build -f server/Dockerfile -t amby-sync-server sync/
# Stage Э2, step 2: minimal. The multi-stage build, a non-root user, the /data volume and a
# health check are here; the compose example with Caddy comes with the server code.

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY proto proto
COPY core core
COPY server server
COPY conformance conformance
RUN cargo build --release --locked -p amby-sync-server

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data amby \
 && mkdir /data \
 && chown amby /data
COPY --from=build /src/target/release/amby-sync-server /usr/local/bin/amby-sync-server
USER amby
ENV AMBY_SYNC_DATA_DIR=/data \
    AMBY_SYNC_LISTEN=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
# A TCP connect is enough for "the process is listening"; the image has no curl.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]
ENTRYPOINT ["amby-sync-server"]
CMD ["serve"]
