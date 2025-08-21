import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import { loadConfig, validateStreamUrl, type BotConfig } from "./config.js";

class DiscordStreamBot {
  private client: Client;
  private streamer: Streamer;
  private config: BotConfig;
  private currentController?: AbortController;
  private isStreaming = false;
  private readonly commandPrefix = "!";

  constructor(config: BotConfig) {
    this.config = config;
    this.client = new Client();
    this.streamer = new Streamer(this.client);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on("ready", () => {
      console.log(`🚀 Bot is ready! Logged in as ${this.client.user?.tag}`);
      console.log(`🔊 Will join the user's current voice channel automatically`);
      console.log(`🎮 Command prefix: ${this.commandPrefix}`);
      console.log("");
      console.log("Available commands:");
      console.log(`  ${this.commandPrefix}stream <url> - Start streaming from URL`);
      console.log(`  ${this.commandPrefix}stop - Stop current stream`);
      console.log(`  ${this.commandPrefix}disconnect - Disconnect from voice`);
      console.log(`  ${this.commandPrefix}status - Show bot status`);
      console.log(`  ${this.commandPrefix}help - Show help message`);
    });

    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) return;

      // Check if message starts with command prefix
      if (!message.content.startsWith(this.commandPrefix)) {
        return;
      }

      await this.handleCommand(message);
    });

    this.client.on("error", (error) => {
      console.error("❌ Discord client error:", error);
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n🛑 Shutting down bot...");
      this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("\n🛑 Shutting down bot...");
      this.cleanup();
      process.exit(0);
    });
  }

  private async handleCommand(message: any): Promise<void> {
    const args = message.content.slice(this.commandPrefix.length).trim().split(/ +/);
    const command = args.shift()?.toLowerCase();

    try {
      switch (command) {
        case "stream":
          await this.handleStreamCommand(message, args);
          break;
        case "stop":
          await this.handleStopCommand(message);
          break;
        case "disconnect":
          await this.handleDisconnectCommand(message);
          break;
        case "status":
          await this.handleStatusCommand(message);
          break;
        case "help":
          await this.handleHelpCommand(message);
          break;
        default:
          await message.reply(
            `❌ Unknown command. Use \`${this.commandPrefix}help\` for available commands.`
          );
      }
    } catch (error) {
      console.error(`❌ Error handling command ${command}:`, error);
      await message.reply("❌ An error occurred while processing the command.");
    }
  }

  private async handleStreamCommand(message: any, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply(`❌ Please provide a URL. Usage: \`${this.commandPrefix}stream <url>\``);
      return;
    }

    const url = args.join(" ");

    if (!validateStreamUrl(url)) {
      await message.reply("❌ Invalid URL. Please provide a valid HTTP, HTTPS, or RTMP URL.");
      return;
    }

    if (this.isStreaming) {
      await message.reply(
        `⚠️ Already streaming! Use \`${this.commandPrefix}stop\` to stop the current stream first.`
      );
      return;
    }

    // Check if user is in a voice channel
    const voiceChannel = message.author.voice?.channel;
    if (!voiceChannel) {
      await message.reply(
        "❌ You need to be in a voice channel first! Please join a voice channel and try again."
      );
      return;
    }

    const statusMsg = await message.reply("🔄 Preparing to stream...");

    try {
      // Join the user's voice channel
      console.log(
        `🔊 Joining voice channel ${message.guildId}/${voiceChannel.id} (${voiceChannel.name})`
      );
      await this.streamer.joinVoice(message.guildId!, voiceChannel.id);

      // Handle stage channels
      if (voiceChannel instanceof StageChannel) {
        await this.client.user?.voice?.setSuppressed(false);
      }

      // Stop any existing stream
      this.currentController?.abort();
      this.currentController = new AbortController();

      console.log(`📺 Preparing stream for URL: ${url}`);

      const { command, output } = prepareStream(
        url,
        {
          width: this.config.streamOpts.width,
          height: this.config.streamOpts.height,
          frameRate: this.config.streamOpts.fps,
          bitrateVideo: this.config.streamOpts.bitrateKbps,
          bitrateVideoMax: this.config.streamOpts.maxBitrateKbps,
          hardwareAcceleratedDecoding: this.config.streamOpts.hardwareAcceleration,
          videoCodec: Utils.normalizeVideoCodec(this.config.streamOpts.videoCodec),
        },
        this.currentController.signal
      );

      command.on("error", (err) => {
        console.error("❌ FFmpeg error:", err);
        this.isStreaming = false;
      });

      command.on("stderr", (data) => {
        // Log FFmpeg output for debugging (optional)
        console.log("FFmpeg:", data.toString());
      });

      this.isStreaming = true;

      const successMsg = `✅ Started streaming: \`${url}\`\n🎬 Resolution: ${this.config.streamOpts.width}x${this.config.streamOpts.height} @ ${this.config.streamOpts.fps}fps\n📊 Bitrate: ${this.config.streamOpts.bitrateKbps}kbps`;

      await statusMsg?.edit(successMsg);

      // Start streaming
      await playStream(output, this.streamer, undefined, this.currentController.signal);

      console.log("✅ Stream ended successfully");
      this.isStreaming = false;
    } catch (error: any) {
      console.error("❌ Stream error:", error);
      this.isStreaming = false;

      if (error.name === "AbortError") {
        console.log("🛑 Stream was stopped");
        return;
      }

      const errorMsg = `❌ Failed to start stream: ${error.message}`;
      await statusMsg?.edit(errorMsg);
    }
  }

  private async handleStopCommand(message: any): Promise<void> {
    if (!this.isStreaming) {
      await message.reply("⚠️ No stream is currently active.");
      return;
    }

    this.currentController?.abort();
    this.isStreaming = false;

    await message.reply("🛑 Stream stopped successfully.");
    console.log("🛑 Stream stopped by user command");
  }

  private async handleDisconnectCommand(message: any): Promise<void> {
    this.currentController?.abort();
    this.isStreaming = false;
    this.streamer.leaveVoice();

    await message.reply("👋 Disconnected from voice channel and stopped streaming.");
    console.log("👋 Disconnected from voice channel");
  }

  private async handleStatusCommand(message: any): Promise<void> {
    const voiceConnection = this.streamer.voiceConnection;
    const isConnected = !!voiceConnection;

    let statusMessage = "📊 **Bot Status**\n";
    statusMessage += `🤖 Client: ${this.client.user?.tag}\n`;
    statusMessage += `🔊 Voice Connected: ${isConnected ? "✅ Yes" : "❌ No"}\n`;
    statusMessage += `📺 Streaming: ${this.isStreaming ? "✅ Active" : "❌ Inactive"}\n`;

    if (isConnected && voiceConnection) {
      statusMessage += `📍 Channel: <#${voiceConnection.channelId}>\n`;
    }

    statusMessage += `\n⚙️ **Stream Settings**\n`;
    statusMessage += `📏 Resolution: ${this.config.streamOpts.width}x${this.config.streamOpts.height}\n`;
    statusMessage += `🎬 FPS: ${this.config.streamOpts.fps}\n`;
    statusMessage += `📊 Bitrate: ${this.config.streamOpts.bitrateKbps}kbps (max: ${this.config.streamOpts.maxBitrateKbps}kbps)\n`;
    statusMessage += `🎥 Codec: ${this.config.streamOpts.videoCodec}\n`;
    statusMessage += `⚡ Hardware Acceleration: ${this.config.streamOpts.hardwareAcceleration ? "✅ Enabled" : "❌ Disabled"}`;

    await message.reply(statusMessage);
  }

  private async handleHelpCommand(message: any): Promise<void> {
    const helpMessage =
      `🎬 **Discord Video Stream Bot Help**\n\n` +
      `**Available Commands:**\n` +
      `\`${this.commandPrefix}stream <url>\` - Start streaming from URL\n` +
      `\`${this.commandPrefix}stop\` - Stop the current stream\n` +
      `\`${this.commandPrefix}disconnect\` - Disconnect from voice channel\n` +
      `\`${this.commandPrefix}status\` - Show bot and stream status\n` +
      `\`${this.commandPrefix}help\` - Show this help message\n\n` +
      `**Supported URLs:**\n` +
      `• Direct video files (MP4, MKV, AVI, etc.)\n` +
      `• Livestreams (HLS, DASH, RTMP)\n` +
      `• Various streaming platforms\n\n` +
      `**Current Settings:**\n` +
      `📏 Resolution: ${this.config.streamOpts.width}x${this.config.streamOpts.height}\n` +
      `🎬 FPS: ${this.config.streamOpts.fps}\n` +
      `📊 Bitrate: ${this.config.streamOpts.bitrateKbps}kbps`;

    await message.reply(helpMessage);
  }

  private cleanup(): void {
    this.currentController?.abort();
    this.isStreaming = false;
    if (this.streamer.voiceConnection) {
      this.streamer.leaveVoice();
    }
    this.client.destroy();
  }

  public async start(): Promise<void> {
    try {
      console.log("🚀 Starting Discord Stream Bot...");
      await this.client.login(this.config.token);
    } catch (error) {
      console.error("❌ Failed to start bot:", error);
      throw error;
    }
  }
}

// Main execution
async function main(): Promise<void> {
  try {
    console.log("📋 Loading configuration...");
    const config = await loadConfig();

    console.log("🤖 Initializing bot...");
    const bot = new DiscordStreamBot(config);

    await bot.start();
  } catch (error) {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  }
}

main();
