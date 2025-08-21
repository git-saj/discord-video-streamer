# Discord Video Stream Bot 🎥

[![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen?logo=pre-commit)](https://github.com/pre-commit/pre-commit)
[![Code Quality](https://img.shields.io/badge/code%20quality-biome-60a5fa)](https://biomejs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A high-performance Discord bot for streaming videos from URLs using message commands. Built with TypeScript and
optimized for 1080p 30fps streaming.

## Features ✨

- 🎬 **High Quality Streaming**: 1080p 30fps video streaming
- ⚡ **Message Commands**: Simple and reliable message-based command interface
- 🔗 **URL Support**: Stream from HTTP, HTTPS, and RTMP URLs
- 🛡️ **User Authorization**: Configurable user access control
- 🐳 **Docker Ready**: Easy deployment with Docker and docker-compose
- 🔧 **Nix Development**: Complete development environment with Nix
- 📊 **Real-time Status**: Check bot and stream status
- 🎯 **Performance Optimized**: Built for reliable streaming performance
- 🔒 **Pre-commit Hooks**: Automated code quality checks and security scanning
- 🛡️ **CI/CD Pipeline**: Comprehensive testing and validation workflows

## Requirements 📋

- Node.js 24 or higher
- FFmpeg
- Discord Bot Token (using discord.js-selfbot-v13@3.7.0)
- Guild and Channel IDs where the bot will operate

## Development Setup 🚀

### Using Nix (Recommended)

If you have Nix installed:

```bash
# Clone the repository
git clone <your-repo-url>
cd discord-video-streamer

# Enter the development shell (installs all dependencies)
nix-shell

# Copy and configure the config file
cp config.example.json config.json
# Edit config.json with your settings

# Build and run the bot
pnpm dev
```

### Manual Setup

```bash
# Clone the repository
git clone <your-repo-url>
cd discord-video-streamer

# Install Node.js 21+, FFmpeg, and other system dependencies
# On Ubuntu/Debian:
sudo apt update
sudo apt install nodejs npm ffmpeg python3 make g++ pkg-config libsodium-dev libzmq3-dev

# Install pnpm
npm install -g pnpm

# Install project dependencies
pnpm install

# Copy and configure the config file
cp config.example.json config.json
# Edit config.json with your settings

# Build the project
pnpm build

# Run the bot
pnpm start
```

## Configuration ⚙️

Create a `config.json` file based on `config.example.json`:

```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN_HERE",
  "guildId": "YOUR_GUILD_ID_HERE",
  "channelId": "YOUR_VOICE_CHANNEL_ID_HERE",
  "allowedUserIds": [
    "YOUR_USER_ID_HERE",
    "ANOTHER_ALLOWED_USER_ID"
  ],
  "streamOpts": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "bitrateKbps": 2500,
    "maxBitrateKbps": 4000,
    "hardwareAcceleration": false,
    "videoCodec": "H264"
  }
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `token` | Discord bot token | Required |
| `guildId` | Discord server (guild) ID | Required |
| `channelId` | Voice channel ID where bot will stream | Required |
| `allowedUserIds` | Array of user IDs allowed to use the bot | Required |
| `streamOpts.width` | Stream width in pixels | 1920 |
| `streamOpts.height` | Stream height in pixels | 1080 |
| `streamOpts.fps` | Frames per second | 30 |
| `streamOpts.bitrateKbps` | Video bitrate in kbps | 2500 |
| `streamOpts.maxBitrateKbps` | Maximum video bitrate in kbps | 4000 |
| `streamOpts.hardwareAcceleration` | Enable hardware acceleration | false |
| `streamOpts.videoCodec` | Video codec (H264/H265) | H264 |

## Docker Deployment 🐳

### Using Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

### Using Docker directly

```bash
# Build the image
docker build -t discord-stream-bot .

# Run the container
docker run -d \
  --name discord-stream-bot \
  -v $(pwd)/config.json:/app/config.json:ro \
  --restart unless-stopped \
  discord-stream-bot
```

## Usage 🎮

Once the bot is running and connected to Discord, you can use these message commands:

### Available Commands

- `!stream <url>` - Start streaming from URL
- `!stop` - Stop the current stream
- `!disconnect` - Disconnect from voice channel
- `!status` - Check bot status
- `!help` - Show help message

**Example:**

```bash
!stream https://example.com/video.mp4
```

**Supported URL types:**

- Direct video files (MP4, MKV, AVI, etc.)
- Livestreams (HLS, DASH, RTMP)
- Various streaming platforms (depends on FFmpeg support)

## Getting Discord IDs 🆔

### Get Guild (Server) ID

1. Enable Developer Mode in Discord Settings > Advanced
2. Right-click on your server name
3. Select "Copy ID"

### Get Channel ID

1. Right-click on the voice channel
2. Select "Copy ID"

### Get User ID

1. Right-click on your username
2. Select "Copy ID"

## Performance Tuning 🔧

### For High Performance

- Enable hardware acceleration if available: `"hardwareAcceleration": true`
- Use H264 codec for better compatibility
- Adjust bitrate based on your network: 2500-4000 kbps for 1080p
- Ensure adequate CPU/GPU resources

### For Lower Resource Usage

- Reduce resolution: `"width": 1280, "height": 720`
- Lower bitrate: `"bitrateKbps": 1500`
- Use lower FPS: `"fps": 24`

## Troubleshooting 🔧

### Common Issues

1. **FFmpeg not found**
   - Ensure FFmpeg is installed and in PATH
   - On Nix: Use the provided shell.nix
   - On Ubuntu: `sudo apt install ffmpeg`

2. **Permission errors**
   - Check that user IDs in config are correct
   - Verify bot token is valid
   - Ensure bot has proper Discord permissions

3. **Stream quality issues**
   - Adjust bitrate settings in config
   - Check network bandwidth
   - Try different video codecs

4. **Bot not responding to commands**
   - Make sure commands start with `!` prefix
   - Ensure bot is in the correct guild/channel
   - Check user permissions in allowedUserIds
   - Try using `!help` to test basic functionality

### Debug Mode

Run with debug logging:

```bash
DEBUG=* pnpm start
```

## Development 💻

### Project Structure

```text
discord-video-streamer/
├── src/
│   ├── index.ts          # Main bot implementation
│   └── config.ts         # Configuration management
├── config.example.json   # Example configuration
├── Dockerfile           # Container configuration
├── docker-compose.yml   # Docker Compose setup
├── shell.nix           # Nix development environment
└── package.json        # Node.js dependencies
```

### Available Scripts

```bash
pnpm build       # Build TypeScript
pnpm start       # Run compiled bot
pnpm dev         # Build and run in one command
pnmp lint        # Run linting
pnmp lint:fix    # Fix linting issues
pnpm format      # Format code with Biome
pnmp format:check # Check code formatting
pnpm type-check  # TypeScript type checking
git cz           # Commit with conventional commit format
```

### Pre-commit Hooks

This project uses pre-commit hooks to ensure code quality:

```bash
# Install pre-commit hooks (done automatically in Nix shell)
pre-commit install

# Run all hooks manually
pre-commit run --all-files

# Update hook versions
pre-commit autoupdate
```

**What gets checked on every commit:**

- 🎨 **Code formatting** with Biome
- 🔍 **Linting** for code quality issues
- 🔒 **Secret detection** to prevent credential leaks
- 📝 **Markdown linting** for documentation quality
- 🐳 **Dockerfile linting** with Hadolint
- 🚀 **TypeScript type checking**
- 📋 **YAML/JSON validation**
- 🔧 **Shell script linting** with ShellCheck

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting (`pnpm lint && pnpm type-check`)
5. Commit using conventional commits (`git cz`)
6. Pre-commit hooks will automatically run quality checks
7. Submit a pull request

**Commit Message Format:**
We use [Conventional Commits](https://conventionalcommits.org/):

```bash
git cz  # Use commitizen for guided commit messages
```

**Code Quality:**

- All code is automatically formatted with Biome
- TypeScript types are strictly checked
- Security scanning prevents credential leaks
- Docker best practices are enforced

## Security Considerations 🔒

- Keep your Discord token secure and never commit it to version control
- Use environment variables or secure config files for sensitive data
- Regularly update dependencies for security patches
- Use Docker for isolated deployment
- Limit allowed user IDs to trusted users only

## License 📄

This project is licensed under the MIT License - see the LICENSE file for details.

## 🎉 **Bot Summary**

### **✅ Production-Ready Discord Video Stream Bot**

**🎬 Core Features:**
- **High-Performance Streaming**: 1080p @ 30fps with 2.5-4Mbps bitrate
- **Message Commands**: Simple `!command` interface (no slash commands - they don't work with selfbots)
- **Node.js 24**: Latest LTS with optimal performance and security
- **TypeScript**: Full type safety and modern development experience
- **Docker Ready**: Multi-stage build with Alpine Linux for minimal size

**🛡️ Enterprise-Grade Quality:**
- **Pre-commit Hooks**: Automatic code formatting, linting, and security scanning
- **CI/CD Pipeline**: Comprehensive testing, security audits, and quality checks  
- **Secret Detection**: Prevents credential leaks with baseline scanning
- **Docker Security**: Best practices with non-root user and health checks
- **Dependency Security**: Automated vulnerability scanning and updates

**⚡ Developer Experience:**
- **Nix Shell**: Complete development environment with zero setup
- **Conventional Commits**: Standardized git workflow with commitizen
- **Pre-commit Quality**: Automatic formatting, linting, and type checking
- **Comprehensive Documentation**: Setup guides, troubleshooting, and examples

### **🚀 Quick Commands:**
```bash
!stream <url>     # Stream video from URL
!stop            # Stop current stream  
!disconnect      # Leave voice channel
!status          # Show bot status
!help            # Show all commands
```

## Acknowledgments 🙏

- Built with [@dank074/discord-video-stream](https://github.com/dank074/Discord-video-stream) v5.0.2
- Uses [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) v3.7.0
- Powered by FFmpeg for video processing
- Modern tooling with Biome v2.2.0, TypeScript v5.9.2, and Node.js 24 LTS
- Enterprise-grade quality with pre-commit hooks and comprehensive CI/CD

## Support 💬

If you encounter issues or have questions:

1. Check the troubleshooting section above
2. Review the configuration options
3. Check FFmpeg and Node.js versions
4. Create an issue with detailed logs and configuration (remove sensitive data)

---

**Note:** This bot uses a selfbot library. Please ensure compliance with Discord's Terms of Service when using this bot.
