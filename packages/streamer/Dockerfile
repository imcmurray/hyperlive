# Single-container streamer: Xvfb + Chromium (driven by Puppeteer) + ffmpeg.
# We keep all three in one container because they must share one X display;
# splitting them across compose services means sharing the X socket, which is
# more fragile than it's worth for the spike.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      xvfb \
      x11-utils \
      dumb-init \
      # audio: a virtual PulseAudio sink the DJ plays into and ffmpeg captures,
      # so songs switch live without ever restarting the RTMP push. mpv = player.
      pulseaudio \
      pulseaudio-utils \
      mpv \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      ca-certificates \
      # Mesa (Intel iris/anv) — enables GPU rendering when CAPTURE=screencast
      libgl1-mesa-dri \
      libglx-mesa0 \
      libegl-mesa0 \
      libgbm1 \
      mesa-vulkan-drivers \
      mesa-va-drivers \
      intel-media-va-driver \
      i965-va-driver \
      vainfo \
  && rm -rf /var/lib/apt/lists/*

# Don't let puppeteer-core try to download a browser; use the distro Chromium.
# MESA_LOADER_DRIVER_OVERRIDE=iris → GL/Vulkan; LIBVA_DRIVER_NAME=iHD → VAAPI encode.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    LIBVA_DRIVER_NAME=iHD \
    MESA_LOADER_DRIVER_OVERRIDE=iris

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# control/ holds the runtime directives file (bind-mounted in compose)
RUN mkdir -p /app/control

ENTRYPOINT ["dumb-init", "--"]
CMD ["bash", "start.sh"]
