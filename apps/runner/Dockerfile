FROM node:24-slim
WORKDIR /app
RUN useradd --system --no-create-home --shell /usr/sbin/nologin egress \
  && useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin browser \
  && groupadd --system trawler-downloads && usermod -aG trawler-downloads node && usermod -aG trawler-downloads browser \
  && install -d -o root -g trawler-downloads -m 2770 /var/lib/trawler-downloads
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_ENV=production TRAWLER_REQUIRE_EGRESS=1 TRAWLER_BROWSER_LAUNCHER=/usr/local/bin/trawler-chromium TRAWLER_BROWSER_DOWNLOADS=/var/lib/trawler-downloads
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/runner/package.json apps/runner/
COPY apps/demo/package.json apps/demo/
RUN npm ci --workspace @usetrawler/runner --include-workspace-root=false \
  && npx -w @usetrawler/core playwright install --with-deps chromium \
  && apt-get update && apt-get install -y --no-install-recommends sudo tini \
  && rm -rf /root/.npm /var/lib/apt/lists/*
COPY --chmod=0755 apps/runner/browser/trawler-chromium /usr/local/bin/trawler-chromium
COPY --chmod=0755 apps/runner/browser/trawler-chromium-as-browser /usr/local/libexec/trawler-chromium-as-browser
COPY --chmod=0440 apps/runner/browser/sudoers /etc/sudoers.d/trawler-browser
RUN chrome="$(find /ms-playwright -path '*chrome-headless-shell*' -name chrome-headless-shell -type f)" \
  && test "$(printf '%s\n' "$chrome" | wc -l)" = 1 && test -x "$chrome" \
  && sed -i "s#@CHROME@#$chrome#" /usr/local/libexec/trawler-chromium-as-browser \
  && visudo -cf /etc/sudoers.d/trawler-browser \
  && find / -xdev -perm -4000 -type f ! -path /usr/bin/sudo -exec chmod u-s {} +
COPY packages packages
COPY apps/runner apps/runner
ARG TRAWLER_COMMIT
ARG RAILWAY_GIT_COMMIT_SHA
ENV TRAWLER_COMMIT=${TRAWLER_COMMIT:-$RAILWAY_GIT_COMMIT_SHA}
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["apps/runner/start.sh"]
