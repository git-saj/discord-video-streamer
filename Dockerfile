# Simplified multi-stage Alpine Dockerfile
FROM node:24-alpine AS builder

# Install build dependencies
RUN apk add --no-cache --virtual .build-deps \
    python3 \
    make \
    g++ \
    pkgconfig \
    libsodium-dev \
    zeromq-dev

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

# Clean up builder stage
RUN apk del .build-deps

# Production stage
FROM alpine:3.20 AS production

# Install runtime dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    ffmpeg \
    libsodium \
    zeromq \
    dumb-init && \
    rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S discordbot -u 1001 -G nodejs

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
COPY --from=builder --chown=discordbot:nodejs /app/dist ./dist

# Create logs directory
RUN mkdir -p logs && \
    chown discordbot:nodejs logs

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
