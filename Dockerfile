FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY .packages/ .packages/
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm rebuild @larksuite/cli --ignore-scripts=false
# Agent Connectors' browser connection runs agent-browser, whose package carries every platform's binary (~116 MB).
# Keep only this image's, executable; its install script stays denied in allowScripts.
ARG TARGETARCH
RUN arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
    && find node_modules -path '*/agent-browser/bin/agent-browser-*' ! -name "agent-browser-linux-$arch" ! -name '*.js' -delete \
    && find node_modules -path "*/agent-browser/bin/agent-browser-linux-$arch" -exec chmod 0755 {} +
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build
COPY web/package.json web/package-lock.json web/
COPY web/ui/package.json web/ui/
RUN npm --prefix web ci --ignore-scripts --no-audit --no-fund
COPY web/ web/
RUN npm run build:web
# The official Google Workspace CLI release the Google connector runs (gws_read / gws_write).
ARG TARGETARCH
ARG GWS_VERSION=0.22.5
RUN case "$TARGETARCH" in \
      arm64) arch=aarch64; sum=e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a ;; \
      *) arch=x86_64; sum=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920 ;; \
    esac \
    && curl -fsSL -o /tmp/gws.tar.gz "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-${arch}-unknown-linux-musl.tar.gz" \
    && echo "$sum  /tmp/gws.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/gws && tar xzf /tmp/gws.tar.gz -C /opt/gws ./gws ./LICENSE && rm /tmp/gws.tar.gz
# State replication for a container without a persistent disk (cloudflare/container/start.sh): Litestream copies the
# SQLite databases as they change, rclone the other files.
ARG LITESTREAM_VERSION=0.5.18
ARG RCLONE_VERSION=1.76.0
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
      arm64) litestream=arm64; litestream_sum=922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d; rclone=arm64; rclone_sum=ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78 ;; \
      *) litestream=x86_64; litestream_sum=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea; rclone=amd64; rclone_sum=b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7 ;; \
    esac \
    && curl -fsSL -o /tmp/litestream.tar.gz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${litestream}.tar.gz" \
    && curl -fsSL -o /tmp/rclone.zip "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${rclone}.zip" \
    && printf '%s  %s\n' "$litestream_sum" /tmp/litestream.tar.gz "$rclone_sum" /tmp/rclone.zip | sha256sum -c - \
    && mkdir -p /opt/replication && tar xzf /tmp/litestream.tar.gz -C /opt/replication litestream \
    && unzip -j -q /tmp/rclone.zip "rclone-v${RCLONE_VERSION}-linux-${rclone}/rclone" -d /opt/replication \
    && rm /tmp/litestream.tar.gz /tmp/rclone.zip

FROM node:24.22.2-bookworm-slim
WORKDIR /app
# python3 and age run the daily encrypted backup (Agent Environment's server-backup.py).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates python3 age \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 700 /state /config /var/lib/litestream
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web
COPY --from=build /opt/gws /opt/gws
COPY --from=build /opt/replication/litestream /opt/replication/rclone /usr/local/bin/
COPY cloudflare/container/ ./container/
COPY package.json LICENSE NOTICE THIRD_PARTY_NOTICES components.json ./
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
# What is the same in every deployment. The rest is in the configuration bucket's mau.env.
ENV HOST=0.0.0.0 PORT=8790 MAU_STATE=/state AGENT_SERVICE_STATE=/state/router MAU_CONFIG_FILE=/config/mau.json \
    MAU_WEB_ROOT=/app/web AGENT_CONNECTORS_GWS_BINARY=/opt/gws/gws
USER node
EXPOSE 8790
ENTRYPOINT ["/app/container/start.sh"]
