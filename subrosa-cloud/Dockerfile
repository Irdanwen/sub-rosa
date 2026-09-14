# syntax=docker/dockerfile:1
FROM lukemathwalker/cargo-chef:0.1.77-rust-1.95.0-slim-trixie AS chef
WORKDIR /app
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --locked --release --bin subrosa-cloud
FROM debian:13-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin subrosa
WORKDIR /app
COPY --from=builder /app/target/release/subrosa-cloud /usr/local/bin/subrosa-cloud
USER 10001:10001
EXPOSE 8088
ENTRYPOINT ["/usr/local/bin/subrosa-cloud"]
CMD ["serve"]
