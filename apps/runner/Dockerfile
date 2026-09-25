FROM node:24-slim
ARG TRAWLER_COMMIT
ARG RAILWAY_GIT_COMMIT_SHA
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_ENV=production TRAWLER_COMMIT=${TRAWLER_COMMIT:-$RAILWAY_GIT_COMMIT_SHA}
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/runner/package.json apps/runner/
RUN npm ci --workspace @usetrawler/runner --include-workspace-root=false \
  && npx -w @usetrawler/core playwright install --with-deps chromium \
  && rm -rf /root/.npm /var/lib/apt/lists/*
COPY packages packages
COPY apps/runner apps/runner
USER node
CMD ["sh", "-c", "exec node apps/runner/bin/trawler-runner.js work --control-plane \"$TRAWLER_CONTROL_PLANE\""]
