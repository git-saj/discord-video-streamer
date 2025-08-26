#!/bin/bash

# Discord Stream Bot with NVENC Hardware Acceleration
# This script runs the Discord bot with proper NVIDIA GPU support for NixOS

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Discord Stream Bot with NVENC${NC}"
echo "=========================================="
echo ""

# Check if Docker image exists
if ! docker image inspect discord-stream-bot:latest >/dev/null 2>&1; then
    echo -e "${RED}❌ discord-stream-bot:latest image not found${NC}"
    echo "Please build the image first:"
    echo "  docker build -t discord-stream-bot:latest ."
    exit 1
fi

# Check if config.jsonc exists
if [[ ! -f "config.jsonc" ]]; then
    echo -e "${RED}❌ config.jsonc not found${NC}"
    echo "Please create a config.jsonc file in the current directory"
    echo "You can use config/template.jsonc as a starting point"
    exit 1
fi

# Check hardware acceleration setting
hw_accel=$(grep -o '"name":\s*"nvenc"' config.jsonc >/dev/null 2>&1 && echo "true" || echo "false")
if [[ "$hw_accel" != "true" ]]; then
    echo -e "${YELLOW}⚠️  NVENC hardware acceleration is not enabled in config.jsonc${NC}"
    echo "Consider setting encoder name to: \"nvenc\""
fi

echo -e "${BLUE}🔍 Finding NVIDIA library paths...${NC}"

# Get the actual Nix store path for NVIDIA libraries
NVIDIA_STORE_PATH=""
if [[ -L "/run/opengl-driver/lib/libcuda.so.1" ]]; then
    NVIDIA_STORE_PATH=$(readlink /run/opengl-driver/lib/libcuda.so.1 | sed 's|/lib/libcuda.so.1||')

    if [[ -d "$NVIDIA_STORE_PATH/lib" ]]; then
        echo -e "${GREEN}✅ Found NVIDIA libraries: $NVIDIA_STORE_PATH/lib${NC}"
    else
        echo -e "${YELLOW}⚠️  NVIDIA library path invalid${NC}"
        NVIDIA_STORE_PATH=""
    fi
else
    echo -e "${YELLOW}⚠️  NVIDIA libraries not found in expected location${NC}"
fi

# Create logs directory if it doesn't exist
mkdir -p logs

# Stop and remove existing container if it exists
if docker ps -a --format '{{.Names}}' | grep -q "^discord-stream-bot$"; then
    echo -e "${YELLOW}Stopping existing container...${NC}"
    docker stop discord-stream-bot >/dev/null 2>&1 || true
    docker rm discord-stream-bot >/dev/null 2>&1 || true
fi

echo ""
echo -e "${BLUE}🏃 Starting Discord Stream Bot...${NC}"

# Build Docker run command
DOCKER_ARGS=(
    "run"
    "-d"
    "--name" "discord-stream-bot"
    "--restart" "unless-stopped"
    "-v" "$(pwd)/config.jsonc:/app/config.jsonc:ro"
    "-v" "$(pwd)/logs:/app/logs"
)

# Add NVIDIA support if available
if [[ -n "$NVIDIA_STORE_PATH" ]]; then
    echo "Using NVIDIA hardware acceleration..."

    # Add device mounts
    DOCKER_ARGS+=(
        "--device=/dev/nvidia0"
        "--device=/dev/nvidiactl"
        "--device=/dev/nvidia-modeset"
        "--device=/dev/nvidia-uvm"
    )

    # Add capability devices if they exist
    if [[ -e "/dev/nvidia-caps/nvidia-cap1" ]]; then
        DOCKER_ARGS+=("--device=/dev/nvidia-caps/nvidia-cap1")
    fi
    if [[ -e "/dev/nvidia-caps/nvidia-cap2" ]]; then
        DOCKER_ARGS+=("--device=/dev/nvidia-caps/nvidia-cap2")
    fi

    # Mount NVIDIA libraries
    DOCKER_ARGS+=(
        "-v" "$NVIDIA_STORE_PATH/lib:/usr/local/nvidia/lib:ro"
        "-e" "NVIDIA_VISIBLE_DEVICES=all"
        "-e" "NVIDIA_DRIVER_CAPABILITIES=compute,utility,video"
        "-e" "LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/cuda/lib64:/opt/ffmpeg/lib"
    )
else
    echo -e "${YELLOW}Running without NVIDIA hardware acceleration${NC}"
fi

# Add image name
DOCKER_ARGS+=("discord-stream-bot:latest")

# Run the container
if docker "${DOCKER_ARGS[@]}"; then
    echo ""
    echo -e "${GREEN}✅ Discord Stream Bot started successfully!${NC}"
    echo ""
    echo -e "${BLUE}📊 Container Status:${NC}"
    docker ps --filter "name=discord-stream-bot" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo -e "${BLUE}📝 Useful Commands:${NC}"
    echo "  View logs:    docker logs -f discord-stream-bot"
    echo "  Stop bot:     docker stop discord-stream-bot"
    echo "  Restart:      docker restart discord-stream-bot"
    echo "  Remove:       docker stop discord-stream-bot && docker rm discord-stream-bot"

    # Show logs for a few seconds
    echo ""
    echo -e "${BLUE}📋 Initial logs:${NC}"
    docker logs discord-stream-bot

    echo ""
    echo -e "${GREEN}🎮 Bot is running! Check Discord for the bot status.${NC}"
else
    echo ""
    echo -e "${RED}❌ Failed to start Discord Stream Bot${NC}"
    echo "Check the logs for more details:"
    echo "  docker logs discord-stream-bot"
    exit 1
fi
