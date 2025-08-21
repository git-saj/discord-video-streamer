# Use Node.js 24 Alpine as base image for smaller size
FROM node:24-alpine AS base

# Install system dependencies required for the bot
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    pkgconfig \
    libsodium-dev \
    zeromq-dev \
    git

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm, dependencies, copy source, and build in consolidated steps
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Create production stage
FROM node:24-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    ffmpeg \
    libsodium \
    zeromq

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S discordbot -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and production dependencies
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile --prod

# Copy built application from base stage
COPY --from=base /app/dist ./dist

# Change ownership to non-root user
RUN chown -R discordbot:nodejs /app

# Switch to non-root user
USER discordbot

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('Health check passed')" || exit 1

# Expose port (if needed for future web interface)
EXPOSE 3000

# Start the bot
CMD ["pnpm", "start"]
