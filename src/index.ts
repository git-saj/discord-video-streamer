import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import { loadConfig, validateStreamUrl, type BotConfig } from "./config.js";

class DiscordStreamBot {
  private client: Client;
  private streamer: Streamer;
  private config: BotConfig;
  private currentController?: AbortController;
  private isStreaming = false;

  constructor(config: BotConfig) {
    this.config = config;
    this.client = new Client();
    this.streamer = new Streamer(this.client);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on("ready", () => {
      console.log(`🚀 Bot is ready! Logged in as ${this.client.user?.tag}`);
      console.log(`📺 Configured for guild: ${this.config.guildId}`);
      console.log(`🔊 Target channel: ${this.config.channelId}`);
      console.log("");
      console.log("✨ This bot responds to slash command interactions");
      console.log("📋 Available interactions: /stream, /stop, /disconnect, /status");
      console.log("⚠️  Note: As a selfbot, commands must be created by other bots");
    });

    // Handle slash command interactions
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isCommand()) return;

      // Check if user is authorized
      if (!this.config.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({
          content: "❌ You are not authorized to use this bot.",
          ephemeral: true,
        });
        return;
      }

      await this.handleSlashCommand(interaction);
    });

    // Fallback to message commands for development/testing
    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) return;

      // Check if user is authorized
      if (!this.config.allowedUserIds.includes(message.author.id)) {
        return;
      }

      // Check if message starts with ! prefix
      if (!message.content.startsWith("!")) {
        return;
      }

      await this.handleMessageCommand(message);
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

  private async handleSlashCommand(interaction: any): Promise<void> {
    const { commandName } = interaction;

    try {
      switch (commandName) {
        case "stream":
          await this.handleStreamCommand(interaction);
          break;
        case "stop":
          await this.handleStopCommand(interaction);
          break;
        case "disconnect":
          await this.handleDisconnectCommand(interaction);
          break;
        case "status":
          await this.handleStatusCommand(interaction);
          break;
        default:
          await interaction.reply({
            content: "❌ Unknown command.",
            ephemeral: true,
          });
      }
    } catch (error) {
      console.error(`❌ Error handling slash command ${commandName}:`, error);

      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({
            content: "❌ An error occurred while processing the command.",
            ephemeral: true,
          });
        } catch (replyError) {
          console.error("Failed to send error reply:", replyError);
        }
      }
    }
  }

  private async handleMessageCommand(message: any): Promise<void> {
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift()?.toLowerCase();

    try {
      switch (command) {
        case "stream":
          await this.handleStreamMessageCommand(message, args);
          break;
        case "stop":
          await this.handleStopMessageCommand(message);
          break;
        case "disconnect":
          await this.handleDisconnectMessageCommand(message);
          break;
        case "status":
          await this.handleStatusMessageCommand(message);
          break;
        case "help":
          await this.handleHelpCommand(message);
          break;
        default:
          await message.reply("❌ Unknown command. Use `!help` for available commands.");
      }
    } catch (error) {
      console.error(`❌ Error handling message command ${command}:`, error);
      await message.reply("❌ An error occurred while processing the command.");
    }
  }

  private async handleStreamCommand(interaction: any): Promise<void> {
    const url = interaction.options.getString("url");
    await this.startStream(url, interaction, true);
  }

  private async handleStreamMessageCommand(message: any, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply("❌ Please provide a URL. Usage: `!stream <url>`");
      return;
    }
    const url = args.join(" ");
    await this.startStream(url, message, false);
  }

  private async startStream(url: string, context: any, isInteraction: boolean): Promise<void> {
    if (!validateStreamUrl(url)) {
      const errorMsg = "❌ Invalid URL. Please provide a valid HTTP, HTTPS, or RTMP URL.";
      if (isInteraction) {
        await context.reply({
          content: errorMsg,
          ephemeral: true,
        });
      } else {
        await context.reply(errorMsg);
      }
      return;
    }

    if (this.isStreaming) {
      const errorMsg =
        "⚠️ Already streaming! Use `/stop` or `!stop` to stop the current stream first.";
      if (isInteraction) {
        await context.reply({
          content: errorMsg,
          ephemeral: true,
        });
      } else {
        await context.reply(errorMsg);
      }
      return;
    }

    if (isInteraction) {
      await context.deferReply();
    }

    let statusMsg: any = null;
    if (!isInteraction) {
      statusMsg = await context.reply("🔄 Preparing to stream...");
    }

    try {
      // Join voice channel
      console.log(`🔊 Joining voice channel ${this.config.guildId}/${this.config.channelId}`);
      await this.streamer.joinVoice(this.config.guildId, this.config.channelId);

      // Handle stage channels
      const channel = await this.client.channels.fetch(this.config.channelId);
      if (channel instanceof StageChannel) {
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

      if (isInteraction) {
        await context.editReply({
          content: successMsg,
        });
      } else {
        await statusMsg?.edit(successMsg);
      }

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

      try {
        if (isInteraction) {
          await context.editReply({
            content: errorMsg,
          });
        } else {
          await statusMsg?.edit(errorMsg);
        }
      } catch (editError) {
        console.error("Failed to edit reply:", editError);
      }
    }
  }

  private async handleStopCommand(interaction: any): Promise<void> {
    if (!this.isStreaming) {
      await interaction.reply({
        content: "⚠️ No stream is currently active.",
        ephemeral: true,
      });
      return;
    }

    this.currentController?.abort();
    this.isStreaming = false;

    await interaction.reply({
      content: "🛑 Stream stopped successfully.",
    });

    console.log("🛑 Stream stopped by slash command");
  }

  private async handleStopMessageCommand(message: any): Promise<void> {
    if (!this.isStreaming) {
      await message.reply("⚠️ No stream is currently active.");
      return;
    }

    this.currentController?.abort();
    this.isStreaming = false;

    await message.reply("🛑 Stream stopped successfully.");
    console.log("🛑 Stream stopped by message command");
  }

  private async handleDisconnectCommand(interaction: any): Promise<void> {
    this.currentController?.abort();
    this.isStreaming = false;
    this.streamer.leaveVoice();

    await interaction.reply({
      content: "👋 Disconnected from voice channel and stopped streaming.",
    });

    console.log("👋 Disconnected from voice channel via slash command");
  }

  private async handleDisconnectMessageCommand(message: any): Promise<void> {
    this.currentController?.abort();
    this.isStreaming = false;
    this.streamer.leaveVoice();

    await message.reply("👋 Disconnected from voice channel and stopped streaming.");
    console.log("👋 Disconnected from voice channel via message command");
  }

  private async handleStatusCommand(interaction: any): Promise<void> {
    const statusMessage = this.getStatusMessage();
    await interaction.reply({
      content: statusMessage,
      ephemeral: true,
    });
  }

  private async handleStatusMessageCommand(message: any): Promise<void> {
    const statusMessage = this.getStatusMessage();
    await message.reply(statusMessage);
  }

  private getStatusMessage(): string {
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

    return statusMessage;
  }

  private async handleHelpCommand(message: any): Promise<void> {
    const helpMessage =
      `🎬 **Discord Video Stream Bot Help**\n\n` +
      `**Available Commands:**\n` +
      `\`!stream <url>\` - Start streaming from URL\n` +
      `\`!stop\` - Stop the current stream\n` +
      `\`!disconnect\` - Disconnect from voice channel\n` +
      `\`!status\` - Show bot and stream status\n` +
      `\`!help\` - Show this help message\n\n` +
      `**Slash Commands:**\n` +
      `Also responds to \`/stream\`, \`/stop\`, \`/disconnect\`, \`/status\` if available\n\n` +
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
