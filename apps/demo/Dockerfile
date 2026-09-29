FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY apps/demo/package.json apps/demo/
COPY apps/demo/src apps/demo/src
USER node
ARG TRAWLER_COMMIT
ENV TRAWLER_COMMIT=${TRAWLER_COMMIT}
CMD ["node", "apps/demo/src/server.ts"]
