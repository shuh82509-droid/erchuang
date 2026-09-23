FROM node:24-bookworm-slim

WORKDIR /app

RUN sed -i 's|deb.debian.org/debian|mirrors.aliyun.com/debian|g; s|deb.debian.org/debian-security|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::http::Timeout=20 -o Acquire::Retries=3 update \
  && apt-get -o Acquire::http::Timeout=20 -o Acquire::Retries=3 install -y --no-install-recommends \
    ffmpeg \
    fonts-noto-cjk \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
  && rm -rf /var/lib/apt/lists/*

COPY render-worker/package.json render-worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node render-worker ./render-worker
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    TESSERACT_PATH=tesseract \
    WIS_CJK_FONT_FILE=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    WIS_CUTTER_BASE_URL=https://cloud.fandow.com/gpt/marketing-video \
    RENDER_WORKER_HOST=0.0.0.0 \
    RENDER_WORKER_PORT=8787 \
    RENDER_WORKER_DATA_DIR=/data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "render-worker/server.mjs"]
