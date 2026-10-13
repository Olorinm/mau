FROM node:24-bookworm-slim AS build
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

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV HOST=0.0.0.0 PORT=8790 MAU_STATE=/data/mau
USER node
EXPOSE 8790
CMD ["node", "dist/main.js"]
