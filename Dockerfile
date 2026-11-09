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

FROM node:24.22.2-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web
COPY --from=build /opt/gws /opt/gws
COPY package.json LICENSE NOTICE THIRD_PARTY_NOTICES components.json ./
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV HOST=0.0.0.0 PORT=8790 MAU_STATE=/data/mau MAU_WEB_ROOT=/app/web AGENT_CONNECTORS_GWS_BINARY=/opt/gws/gws
USER node
EXPOSE 8790
CMD ["node", "dist/main.js"]
