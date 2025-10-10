# Multi-stage Dockerfile with NVENC support using pre-built FFmpeg
FROM node:24-bullseye AS node-builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    pkg-config \
    libsodium-dev \
    libzmq3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN npm install -g pnpm@latest && \
    pnpm config set ignore-scripts false && \
    pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build

# Production stage with NVIDIA support and BtbN FFmpeg for ZMQ compatibility
FROM nvidia/cuda:12.9.0-runtime-ubuntu24.04

# Install dependencies and BtbN FFmpeg build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y \
    curl \
    xz-utils \
    ca-certificates \
    libsodium23 \
    libzmq5 \
    libzmq5-dev \
    python3 \
    python3-pip \
    dumb-init \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp==2025.08.27 pyzmq==27.0.2 \
    && rm -rf /var/lib/apt/lists/*

# Install FFmpeg from BtbN builds
WORKDIR /tmp
RUN curl -fsSL -o ffmpeg-master-latest-linux64-gpl.tar.xz \
    https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
    && tar -xf ffmpeg-master-latest-linux64-gpl.tar.xz \
    && cp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg /usr/local/bin/ \
    && cp ffmpeg-master-latest-linux64-gpl/bin/ffprobe /usr/local/bin/ \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && rm -rf /tmp/ffmpeg-*

# Create non-root user
RUN groupadd -g 1001 -r nodejs && \
    useradd -r -m -g nodejs -u 1001 discordbot

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@latest && \
    npm cache clean --force

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies
RUN pnpm config set ignore-scripts true && \
    pnpm install --frozen-lockfile --prod && \
    pnpm store prune && \
    rm -rf ~/.npm ~/.pnpm-store ~/.cache

# Copy built application
COPY --from=node-builder --chown=discordbot:nodejs /app/build ./build

# Copy config template directory
COPY --chown=discordbot:nodejs config ./config

# Create logs directory with proper permissions
RUN mkdir -p logs && \
    chown discordbot:nodejs logs

# Create startup script
COPY <<EOF /start.sh
#!/bin/bash
echo "Starting Discord bot..."

# Check if config.jsonc exists, if not use template
if [[ ! -f "/app/config.jsonc" && -f "/app/config/template.jsonc" ]]; then
    echo "No config.jsonc found, please mount your config file to /app/config.jsonc"
    echo "Using template config for reference (bot will likely fail without proper config)"
    cp /app/config/template.jsonc /app/config.jsonc
fi

# Start the bot with config.jsonc as argument
exec node build/index.js /app/config.jsonc
EOF

RUN chmod +x /start.sh

# Set NVIDIA environment variables
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

# Switch to non-root user
USER discordbot

# Environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=512"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/healthz || exit 1

# Use dumb-init for signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start bot
CMD ["/start.sh"]
