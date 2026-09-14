FROM agent-sandbox-base:latest

# A real X session inside the guest: Xvnc renders to a framebuffer, openbox gives
# windows a frame, and socat republishes the RFB port on vsock so the host can
# bridge it to a browser (see src/routes/vnc.ts).
#
# As with the browser template, these ENV lines apply to the build only —
# build.sh ships the rootfs via `docker export`, which carries the filesystem and
# not the image config, so the runtime values are written to /etc/environment
# (sourced by start.sh) further down.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_BIN=/usr/bin/chromium-browser \
    NODE_PATH=/usr/local/lib/node_modules \
    DISPLAY=:1

# tigervnc supplies Xvnc; xdpyinfo is how the boot hook knows the display is
# actually accepting connections; xdotool and scrot are the agent's hands and
# eyes. chromium-swiftshader provides software GL, since the microVM has no GPU.
# libwebp-tools supplies cwebp: scrot only writes PNG, and a full-screen capture
# re-encodes to roughly a third the size, which matters when every frame crosses
# vsock as base64 inside a JSON body.
RUN apk add --no-cache \
      tigervnc \
      xdpyinfo \
      xset \
      openbox \
      xdotool \
      scrot \
      libwebp-tools \
      npm \
      chromium \
      chromium-swiftshader \
      nss \
      freetype \
      harfbuzz \
      ttf-dejavu \
      ttf-freefont \
      font-noto-emoji \
      fontconfig \
    && npm install -g playwright-core \
    && fc-cache -f \
    && rm -rf /var/cache/apk/* /root/.npm /tmp/*

# Node resolves modules by walking up from the script's directory, so /node_modules
# is reachable from /workspace regardless of environment.
RUN ln -sf /usr/local/lib/node_modules /node_modules

COPY templates/desktop/boot.d/ /etc/sandbox/boot.d/
COPY templates/desktop/bin/ /usr/local/bin/

RUN chmod +x /etc/sandbox/boot.d/*.sh /usr/local/bin/desktop-* \
    && mkdir -p /tmp/xdg

# start.sh sources /etc/environment, and the guest runtime passes its environment
# to every spawned command — this is what makes `DISPLAY=:1` the default for
# anything an agent runs.
# HOME is on tmpfs on purpose: the guest root is read-only, and Chromium's
# crashpad handler dies with SIGTRAP ("--database is required") when it cannot
# write under $HOME — taking the whole browser with it. Verified in a read-only
# container: HOME=/root exits 133, HOME on tmpfs exits 0.
RUN printf '%s\n' \
      'DISPLAY=:1' \
      'DESKTOP_GEOMETRY=1280x800' \
      'HOME=/tmp/desktop-home' \
      'XDG_RUNTIME_DIR=/tmp/xdg' \
      'XDG_CONFIG_HOME=/tmp/desktop-home/.config' \
      'XDG_CACHE_HOME=/tmp/desktop-home/.cache' \
      'NODE_PATH=/usr/local/lib/node_modules' \
      'CHROME_BIN=/usr/bin/chromium-browser' \
      'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1' \
      > /etc/environment

LABEL template.name="desktop" \
      template.displayName="Xvnc desktop (openbox + Chromium)" \
      template.tools="chromium-browser,playwright-core,xdotool,scrot,openbox,node,npm,sh"
