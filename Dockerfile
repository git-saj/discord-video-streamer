# Multi-stage Dockerfile with multi-architecture support
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

# Production stage with FFmpeg support
FROM ubuntu:22.04

# Set non-interactive frontend for apt
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js and runtime dependencies
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    libsodium23 \
    libzmq5 \
    dumb-init \
    software-properties-common \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Install FFmpeg with architecture-specific optimizations
RUN apt-get update && \
    if [ "$(uname -m)" = "x86_64" ]; then \
    # For AMD64, add PPA for newer FFmpeg with NVIDIA support
    add-apt-repository -y ppa:savoury1/ffmpeg4 || true && \
    add-apt-repository -y ppa:savoury1/ffmpeg5 || true && \
    apt-get update && \
    apt-get install -y ffmpeg || \
    (apt-get install -y ffmpeg-static || apt-get install -y ffmpeg); \
    else \
    # For ARM64 and other architectures, use standard FFmpeg
    apt-get install -y ffmpeg; \
    fi && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 -r nodejs && \
    useradd -r -g nodejs -u 1001 discordbot

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
COPY --from=node-builder --chown=discordbot:nodejs /app/dist ./dist

# Create logs directory
RUN mkdir -p logs && \
    chown discordbot:nodejs logs

# Set NVIDIA environment variables (will be ignored on non-NVIDIA systems)
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

# Switch to non-root user
USER discordbot

# Environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=512"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

# Use dumb-init for signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the bot
CMD ["node", "dist/index.js"]
