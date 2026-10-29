FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY .packages/ .packages/
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm rebuild @larksuite/cli --ignore-scripts=false
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci --ignore-scripts --no-audit --no-fund
COPY web/ web/
RUN npm run build:web

FROM node:24.22.2-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web
COPY package.json LICENSE NOTICE components.json ./
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV HOST=0.0.0.0 PORT=8790 MAU_STATE=/data/mau MAU_WEB_ROOT=/app/web
USER node
EXPOSE 8790
CMD ["node", "dist/main.js"]
