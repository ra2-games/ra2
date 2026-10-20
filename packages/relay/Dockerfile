FROM node:alpine AS build
WORKDIR /relay
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY RELAY_PROTOCOL.md LICENSE ./
RUN pnpm run build:server

FROM node:alpine
WORKDIR /app
COPY --from=build --chown=node:node /relay/dist/ ./
ENV NODE_ENV=production
USER node
EXPOSE 15176
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:15176/healthz || exit 1
CMD ["node", "gameRelay.cjs"]
