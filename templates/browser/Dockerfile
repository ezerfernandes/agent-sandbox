FROM agent-sandbox-base:latest

# The root drive is mounted read-only at runtime, so every cache the browser needs
# must be materialised at build time and every writable path must point at tmpfs.
# These ENV lines apply to the build only: build.sh ships the rootfs via
# `docker export`, which carries the filesystem and not the image config, so the
# runtime values have to be written to /etc/environment (sourced by start.sh).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_BIN=/usr/bin/chromium-browser \
    NODE_PATH=/usr/local/lib/node_modules

# playwright-core, not playwright: the latter's postinstall downloads glibc-only
# browser builds that cannot run on musl. Chromium comes from Alpine instead.
RUN apk add --no-cache \
      npm \
      chromium \
      chromium-swiftshader \
      nss \
      freetype \
      harfbuzz \
      ttf-freefont \
      font-noto-emoji \
    && npm install -g playwright-core \
    && fc-cache -f \
    && rm -rf /var/cache/apk/* /root/.npm /tmp/*

# Node resolves modules by walking up from the script's directory, so /node_modules
# is reachable from /workspace regardless of environment. This is the reliable way
# to expose the global install: NODE_PATH depends on start.sh exporting
# /etc/environment, which does not survive the snapshot boot path.
RUN ln -sf /usr/local/lib/node_modules /node_modules

# Belt and braces: start.sh sources /etc/environment when it is present, and the
# guest runtime passes its environment to every spawned command.
RUN printf '%s\n' \
      'NODE_PATH=/usr/local/lib/node_modules' \
      'CHROME_BIN=/usr/bin/chromium-browser' \
      'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1' \
      > /etc/environment

LABEL template.name="browser" \
      template.displayName="Chromium + Playwright" \
      template.tools="chromium-browser,playwright-core,node,npm,sh"
