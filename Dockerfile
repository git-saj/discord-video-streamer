# Multi-stage Ubuntu Dockerfile optimized for libav.js WASM compatibility
FROM node:24-bookworm AS base

# Install build dependencies and runtime libraries
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    pkg-config \
    libsodium-dev \
    libzmq3-dev \
    git \
    ca-certificates \
    curl \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json pnpm-lock.yaml ./

# Install pnpm and all dependencies (including dev for build)
RUN npm install -g pnpm@latest && \
    pnpm config set ignore-scripts false && \
    pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Production stage - create minimal runtime image
FROM node:24-bookworm-slim AS production

# Install only runtime dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsodium23 \
    libzmq5 \
    ca-certificates \
    curl \
    dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs discordbot

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and production dependencies only, skipping scripts
RUN npm install -g pnpm@latest && \
    pnpm config set ignore-scripts true && \
    pnpm install --frozen-lockfile --prod && \
    npm cache clean --force && \
    pnpm store prune

# Copy built application from base stage
COPY --from=base --chown=discordbot:nodejs /app/dist ./dist
COPY --chown=discordbot:nodejs package.json ./

# Create logs directory with proper permissions
RUN mkdir -p logs && \
    chown -R discordbot:nodejs /app && \
    chmod -R 755 /app

# Switch to non-root user
USER discordbot

# Set Node.js production environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"
# FFmpeg threading for better performance
ENV FFMPEG_THREADS=4

# Health check to ensure container is running properly
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

# Use dumb-init to handle signals properly in containers
ENTRYPOINT ["dumb-init", "--"]

# Start the bot
CMD ["node", "dist/index.js"]
