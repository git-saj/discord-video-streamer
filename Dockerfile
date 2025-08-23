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

# Production stage with NVENC support
FROM jrottenberg/ffmpeg:6.0-nvidia2204

# Install Node.js and runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    libsodium23 \
    libzmq5 \
    dumb-init \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

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
    CMD node -e "process.exit(0)" || exit 1

# Use dumb-init for signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the bot
CMD ["node", "dist/index.js"]
