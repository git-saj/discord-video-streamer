#!/bin/bash

# Discord Video Stream Bot Setup Script
# This script helps you set up the Discord Video Stream Bot quickly

set -e  # Exit on any error

echo "🚀 Discord Video Stream Bot Setup"
echo "=================================="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Check if running in Nix shell
if [ -n "$IN_NIX_SHELL" ]; then
    print_status "Running in Nix shell - dependencies should already be available"
else
    print_warning "Not running in Nix shell. Make sure you have Node.js 21+, pnpm, and FFmpeg installed"
fi

# Step 1: Check dependencies
print_step "Checking dependencies..."

# Check Node.js version
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version | sed 's/v//')
    NODE_MAJOR=$(echo $NODE_VERSION | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 21 ]; then
        print_status "Node.js $NODE_VERSION ✓"
    else
        print_error "Node.js version 21+ required, found $NODE_VERSION"
        exit 1
    fi
else
    print_error "Node.js not found. Please install Node.js 21+"
    exit 1
fi

# Check pnpm
if command -v pnpm >/dev/null 2>&1; then
    PNPM_VERSION=$(pnpm --version)
    print_status "pnpm $PNPM_VERSION ✓"
else
    print_warning "pnpm not found. Installing pnpm..."
    npm install -g pnpm
fi

# Check FFmpeg
if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_VERSION=$(ffmpeg -version 2>/dev/null | head -n 1 | cut -d' ' -f3)
    print_status "FFmpeg $FFMPEG_VERSION ✓"
else
    print_error "FFmpeg not found. Please install FFmpeg"
    print_error "  Ubuntu/Debian: sudo apt install ffmpeg"
    print_error "  macOS: brew install ffmpeg"
    print_error "  Or use the provided Nix shell: nix-shell"
    exit 1
fi

# Step 2: Install project dependencies
print_step "Installing project dependencies..."
if [ -f "pnpm-lock.yaml" ]; then
    pnpm install --frozen-lockfile
else
    pnpm install
fi

# Step 3: Setup configuration
print_step "Setting up configuration..."
if [ ! -f "config.json" ]; then
    if [ -f "config.example.json" ]; then
        cp config.example.json config.json
        print_status "Created config.json from example"
        print_warning "Please edit config.json with your Discord bot settings!"
    else
        print_error "config.example.json not found"
        exit 1
    fi
else
    print_status "config.json already exists"
fi

# Step 4: Build the project
print_step "Building the project..."
pnpm build

# Step 5: Setup complete
echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit config.json with your Discord bot settings:"
echo "   - token: Your Discord bot token"
echo "   - guildId: Your Discord server ID"
echo "   - channelId: Voice channel ID where bot will stream"
echo "   - allowedUserIds: Array of user IDs who can use the bot"
echo ""
echo "2. Run the bot:"
echo "   pnpm start"
echo ""
echo "3. Or run in development mode:"
echo "   pnpm dev"
echo ""
echo "For more information, see README.md"
echo ""
print_status "Happy streaming! 🎬"
