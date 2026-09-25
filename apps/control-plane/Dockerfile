FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/runner/package.json apps/runner/
RUN npm ci
COPY packages packages
COPY apps/control-plane apps/control-plane
RUN npm run build -w @usetrawler/control-plane

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/control-plane/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "apps/control-plane/server.js"]
