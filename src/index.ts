import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, playStream } from "@dank074/discord-video-stream";
import { loadConfig, validateStreamUrl, type BotConfig } from "./config.js";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "node:stream";
import {
  botLogger,
  streamLogger,
  discordLogger,
  logFFmpegOutput,
  logStreamStatus,
} from "./logger.js";

class StreamSwitcher {
  private mainOutput: PassThrough;
  private currentCommand: any = null;
  private currentController: AbortController | null = null;
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.mainOutput = new PassThrough();
    this.config = config;
  }

  getOutputStream(): PassThrough {
    return this.mainOutput;
  }

  async switchTo(url: string, abortSignal?: AbortSignal): Promise<void> {
    streamLogger.info("Switching stream source", {
      newUrl: url,
      hasCurrentStream: !!this.currentCommand,
    });

    // Create new FFmpeg command
    const newOutput = new PassThrough();
    const command = ffmpeg(url);

    // Basic input options
    command.inputOptions([
      "-re",
      "-analyzeduration",
      "10000000",
      "-probesize",
      "10000000",
    ]);

    // Simple output configuration
    command
      .outputFormat("matroska")
      .videoCodec("libx264")
      .size(`${this.config.streamOpts.width}x${this.config.streamOpts.height}`)
      .fps(this.config.streamOpts.fps)
      .videoBitrate(`${this.config.streamOpts.bitrateKbps}k`)
      .audioCodec("libopus")
      .audioChannels(2)
      .audioFrequency(48000)
      .audioBitrate("128k");

    // Add essential output options
    command.outputOptions([
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "baseline",
      "-level",
      "3.1",
      "-g",
      String(this.config.streamOpts.fps * 2),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
    ]);

    command.output(newOutput);

    command.on("stderr", (line) => logFFmpegOutput(line));

    // Handle FFmpeg errors
    command.on("error", (error) => {
      if (
        !error.message.includes("signal 15") &&
        !error.message.includes("code 255")
      ) {
        streamLogger.error("FFmpeg process error during switch", {
          error: error.message,
          url: url,
        });
      }
    });

    command.on("end", () => {
      streamLogger.info("FFmpeg process ended during switch", { url });
    });

    // Handle external abort signal
    abortSignal?.addEventListener(
      "abort",
      () => {
        streamLogger.info("Aborting FFmpeg process during switch");
        command.kill("SIGTERM");
      },
      { once: true },
    );

    // Start new FFmpeg process
    try {
      command.run();
      streamLogger.info("New FFmpeg command started", { url });
    } catch (error: any) {
      streamLogger.error("Failed to start new FFmpeg command", {
        error: error.message,
        url,
      });
      throw error;
    }

    // Wait a moment for the new stream to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Clean up old command first to avoid conflicts
    const oldCommand = this.currentCommand;
    if (oldCommand) {
      streamLogger.info("Cleaning up old FFmpeg process");
      try {
        oldCommand.kill("SIGTERM");
      } catch (error: any) {
        streamLogger.warn("Error killing old FFmpeg process", {
          error: error.message,
        });
      }
    }

    // Update current command reference
    this.currentCommand = command;

    // Set up data forwarding from new stream to main output
    newOutput.on("data", (chunk) => {
      if (!this.mainOutput.destroyed) {
        this.mainOutput.write(chunk);
      }
    });

    newOutput.on("end", () => {
      streamLogger.info("New stream output ended", { url });
    });

    newOutput.on("error", (error) => {
      streamLogger.error("New stream output error", {
        error: error.message,
        url,
      });
    });

    streamLogger.info("Stream switch completed successfully", { url });
  }

  stop(): void {
    if (this.currentCommand) {
      streamLogger.info("Stopping StreamSwitcher");
      this.currentCommand.kill("SIGTERM");
      this.currentCommand = null;
    }
  }

  cleanup(): void {
    this.stop();
    if (this.mainOutput && !this.mainOutput.destroyed) {
      this.mainOutput.destroy();
    }
  }
}

class DiscordStreamBot {
  private client: Client;
  private streamer: Streamer;
  private config: BotConfig;
  private currentController?: AbortController;
  private isStreaming = false;
  private currentStreamUrl?: string;
  private streamSwitcher?: StreamSwitcher | null;
  private readonly commandPrefix = "!";

  constructor(config: BotConfig) {
    this.config = config;
    this.client = new Client();
    this.streamer = new Streamer(this.client);
    this.setupEventHandlers();
  }

  private updatePresence(): void {
    const statusText = this.isStreaming
      ? `🔴 Live | ${this.currentStreamUrl?.split("/").pop() || "Stream"}`
      : `✅ ${this.commandPrefix}help | ${this.config.streamOpts.width}x${this.config.streamOpts.height}@${this.config.streamOpts.fps}fps`;

    this.client.user?.setActivity(statusText, {
      type: this.isStreaming ? "STREAMING" : "WATCHING",
    });
  }

  private setupEventHandlers(): void {
    this.client.on("ready", () => {
      // Set initial bot presence
      this.updatePresence();

      botLogger.info("Bot is ready!", {
        user: this.client.user?.tag,
        userId: this.client.user?.id,
        prefix: this.commandPrefix,
        webhooksAllowed: this.config.allowWebhooks,
        guilds: this.client.guilds.cache.size,
      });
      botLogger.info("Available commands:", {
        commands: [
          `${this.commandPrefix}stream [--channel-id <id>] <url> - Start streaming from URL`,
          `${this.commandPrefix}stop - Stop current stream`,
          `${this.commandPrefix}disconnect - Disconnect from voice`,
          `${this.commandPrefix}status - Show bot status`,
          `${this.commandPrefix}help - Show help message`,
        ],
      });
      botLogger.info("Bot configuration:", {
        streamWidth: this.config.streamOpts.width,
        streamHeight: this.config.streamOpts.height,
        streamFps: this.config.streamOpts.fps,
        streamBitrate: this.config.streamOpts.bitrateKbps,
        hardwareAcceleration: this.config.streamOpts.hardwareAcceleration,
        videoCodec: this.config.streamOpts.videoCodec,
      });
    });

    this.client.on("messageCreate", async (message) => {
      // Filter out bots and optionally webhooks based on config
      if (
        message.author.bot &&
        (!this.config.allowWebhooks || !message.webhookId)
      )
        return;

      // Log webhook messages for debugging
      if (message.webhookId) {
        botLogger.info("Webhook message received", {
          webhookId: message.webhookId,
          content: message.content,
          authorTag: message.author.tag,
          authorId: message.author.id,
          channelId: message.channelId,
          guildId: message.guildId,
          allowed: this.config.allowWebhooks,
          timestamp: new Date().toISOString(),
        });
      }

      // Check if message starts with command prefix
      if (!message.content.startsWith(this.commandPrefix)) {
        return;
      }

      await this.handleCommand(message);
    });

    this.client.on("error", (error) => {
      discordLogger.error("Discord client error", {
        error: error.message,
        stack: error.stack,
      });
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      botLogger.warn("Received SIGINT, shutting down gracefully...");
      this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      botLogger.warn("Received SIGTERM, shutting down gracefully...");
      this.cleanup();
      process.exit(0);
    });
  }

  private async handleCommand(message: any): Promise<void> {
    const args = message.content
      .slice(this.commandPrefix.length)
      .trim()
      .split(/ +/);
    const command = args.shift()?.toLowerCase();

    // Log all received commands
    botLogger.info("Command received", {
      command: command,
      args: args.length > 0 ? args : undefined,
      fullContent: message.content,
      userId: message.author.id,
      userTag: message.author.tag,
      username: message.author.username,
      guildId: message.guildId,
      channelId: message.channelId,
      webhookId: message.webhookId || undefined,
      isWebhook: !!message.webhookId,
    });

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
          botLogger.warn("Unknown command attempted", {
            command: command,
            userId: message.author.id,
            userTag: message.author.tag,
          });
          await message.reply(
            `❌ Unknown command. Use \`${this.commandPrefix}help\` for available commands.`,
          );
      }

      // Log successful command completion
      botLogger.info("Command completed successfully", {
        command: command,
        userId: message.author.id,
        userTag: message.author.tag,
      });
    } catch (error) {
      botLogger.error("Error handling command", {
        command,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        userId: message.author.id,
        userTag: message.author.tag,
        args: args.length > 0 ? args : undefined,
      });
      await message.reply("❌ An error occurred while processing the command.");
    }
  }

  private async handleStreamCommand(
    message: any,
    args: string[],
  ): Promise<void> {
    if (args.length === 0) {
      await message.reply(
        `❌ Please provide a URL. Usage: \`${this.commandPrefix}stream [--channel-id <channel_id>] <url>\``,
      );
      return;
    }

    // Parse arguments for --channel-id option
    let channelId: string | null = null;
    const urlArgs = [...args];

    const channelIdIndex = args.indexOf("--channel-id");
    if (channelIdIndex !== -1 && channelIdIndex + 1 < args.length) {
      channelId = args[channelIdIndex + 1];
      // Remove --channel-id and its value from urlArgs
      urlArgs.splice(channelIdIndex, 2);
    }

    const url = urlArgs.join(" ");

    if (!validateStreamUrl(url)) {
      botLogger.warn("Invalid stream URL provided", {
        url: url,
        userId: message.author.id,
        userTag: message.author.tag,
      });
      await message.reply(
        "❌ Invalid URL. Please provide a valid HTTP, HTTPS, or RTMP URL.",
      );
      return;
    }

    // Log stream command details
    streamLogger.info("Stream command initiated", {
      url: url,
      channelId: channelId,
      userId: message.author.id,
      userTag: message.author.tag,
      isWebhook: !!message.webhookId,
      isChannelSwitch: this.isStreaming,
      currentStream: this.currentStreamUrl,
    });

    if (this.isStreaming) {
      // Check if we have StreamSwitcher for seamless switching
      if (this.streamSwitcher) {
        streamLogger.info("Switching to new stream seamlessly", {
          oldStream: this.currentStreamUrl,
          newStream: url,
        });
        await message.reply("🔄 Switching to new stream...");

        try {
          // Switch stream source without stopping Discord stream
          await this.streamSwitcher.switchTo(
            url,
            this.currentController?.signal,
          );
          this.currentStreamUrl = url;

          const successMsg = `✅ Switched to: \`${url}\` (${this.config.streamOpts.width}x${this.config.streamOpts.height}@${this.config.streamOpts.fps}fps, ${this.config.streamOpts.bitrateKbps}kbps)`;
          await message.reply(successMsg);

          streamLogger.info("Stream switch completed", {
            newStream: url,
          });
          return;
        } catch (error: any) {
          streamLogger.error(
            "Failed to switch stream seamlessly, falling back to restart",
            {
              error: error.message,
              url,
            },
          );
          await message.reply(
            "⚠️ Seamless switch failed, restarting stream...",
          );

          // Fall back to full restart
          if (this.currentController) {
            this.currentController.abort();
            delete this.currentController;
          }
          this.isStreaming = false;
          this.streamSwitcher?.cleanup();
          this.streamSwitcher = null;
          delete this.currentStreamUrl;

          // Give time for cleanup
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } else {
        // No StreamSwitcher available, need to do full restart
        streamLogger.info("No StreamSwitcher available, doing full restart", {
          oldStream: this.currentStreamUrl,
          newStream: url,
        });
        await message.reply("🔄 Restarting stream with new source...");

        // Stop current stream and wait for cleanup
        if (this.currentController) {
          this.currentController.abort();
          delete this.currentController;
        }
        this.isStreaming = false;
        delete this.currentStreamUrl;

        // Give time for the stream to properly close
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Determine target voice channel
    let voiceChannel: any;

    if (channelId) {
      // Try to fetch the specified channel
      try {
        const targetChannel = await this.client.channels.fetch(channelId);
        if (
          !targetChannel ||
          !("joinable" in targetChannel) ||
          !("speakable" in targetChannel)
        ) {
          // Check if it's a voice-capable channel using duck typing
          await message.reply(
            `❌ Channel ID \`${channelId}\` is not a valid voice channel.`,
          );
          return;
        }
        voiceChannel = targetChannel;

        botLogger.info("Using specified channel ID", {
          channelId: channelId,
          channelName: voiceChannel.name,
        });
      } catch (_error) {
        await message.reply(
          `❌ Could not find voice channel with ID \`${channelId}\`. Please check the channel ID.`,
        );
        return;
      }
    } else {
      // Use user's current voice channel
      voiceChannel = message.author.voice?.channel;
      if (!voiceChannel) {
        await message.reply(
          "❌ You need to be in a voice channel first! Please join a voice channel or use `--channel-id <channel_id>` to specify one.",
        );
        return;
      }
    }

    const statusMsg = await message.reply("🔄 Preparing to stream...");

    try {
      // Only join if not already in the target channel
      const currentConnection = this.streamer.voiceConnection;
      if (
        !currentConnection ||
        currentConnection.channelId !== voiceChannel.id
      ) {
        botLogger.info("Joining voice channel", {
          guildId: message.guildId || voiceChannel.guildId,
          channelId: voiceChannel.id,
          channelName: voiceChannel.name,
          specifiedById: !!channelId,
        });
        await this.streamer.joinVoice(voiceChannel.guildId, voiceChannel.id);
      } else {
        botLogger.info("Already in target channel, skipping rejoin", {
          channelId: voiceChannel.id,
          channelName: voiceChannel.name,
        });
      }

      // Handle stage channels
      if (voiceChannel instanceof StageChannel) {
        await this.client.user?.voice?.setSuppressed(false);
      }

      // Stop any existing stream
      this.currentController?.abort();
      this.currentController = new AbortController();

      this.currentStreamUrl = url;
      streamLogger.info("Preparing stream", { url });

      // Create StreamSwitcher for seamless switching
      this.streamSwitcher = new StreamSwitcher(this.config);

      // Start initial stream
      await this.streamSwitcher.switchTo(url, this.currentController.signal);

      this.isStreaming = true;
      this.updatePresence();

      const successMsg = `✅ Started streaming: \`${url}\` (${this.config.streamOpts.width}x${this.config.streamOpts.height}@${this.config.streamOpts.fps}fps, ${this.config.streamOpts.bitrateKbps}kbps)`;
      await statusMsg?.edit(successMsg);

      logStreamStatus("starting", { url });

      // Start streaming with the StreamSwitcher output
      try {
        await playStream(
          this.streamSwitcher.getOutputStream(),
          this.streamer,
          {
            type: "go-live",
            readrateInitialBurst: 10, // For low latency
          },
          this.currentController.signal,
        );
      } catch (playStreamError: any) {
        // Handle playStream errors gracefully
        if (playStreamError.name !== "AbortError") {
          throw playStreamError;
        }
        streamLogger.info("PlayStream was aborted during stream switch");
        this.isStreaming = false;
        delete this.currentStreamUrl;
        return;
      }

      logStreamStatus("stopped", { url: this.currentStreamUrl });
      this.isStreaming = false;
      delete this.currentStreamUrl;
    } catch (error: any) {
      streamLogger.error("Stream command failed", {
        error: error.message,
        stack: error.stack,
        url: this.currentStreamUrl,
        stage: "main_catch",
      });

      logStreamStatus("error", {
        error: error.message,
        stack: error.stack,
        url: this.currentStreamUrl,
      });
      this.isStreaming = false;
      delete this.currentStreamUrl;
      this.updatePresence();

      if (error.name === "AbortError") {
        streamLogger.info("Stream was manually stopped or switched", {
          url: this.currentStreamUrl,
        });
        return;
      }

      const errorMsg = `❌ Failed to start stream: ${error.message}`;
      try {
        await statusMsg?.edit(errorMsg);
      } catch (editError) {
        streamLogger.warn("Could not edit status message", {
          error: editError,
        });
      }
    }
  }

  private async handleStopCommand(message: any): Promise<void> {
    if (!this.isStreaming) {
      await message.reply("⚠️ No stream is currently active.");
      return;
    }

    if (this.currentController) {
      this.currentController.abort();
      delete this.currentController;
    }
    this.streamSwitcher?.cleanup();
    this.streamSwitcher = null;
    this.isStreaming = false;
    this.updatePresence();

    await message.reply("🛑 Stream stopped successfully.");
    streamLogger.info("Stream stopped by user command", {
      userId: message.author.id,
      userTag: message.author.tag,
      url: this.currentStreamUrl,
    });
    delete this.currentStreamUrl;
  }

  private async handleDisconnectCommand(message: any): Promise<void> {
    if (this.currentController) {
      this.currentController.abort();
      delete this.currentController;
    }
    this.streamSwitcher?.cleanup();
    this.streamSwitcher = null;
    this.isStreaming = false;
    this.streamer.leaveVoice();
    this.updatePresence();

    await message.reply(
      "👋 Disconnected from voice channel and stopped streaming.",
    );
    botLogger.info("Disconnected from voice channel", {
      userId: message.author.id,
      userTag: message.author.tag,
      url: this.currentStreamUrl,
    });
    delete this.currentStreamUrl;
  }

  private async handleStatusCommand(message: any): Promise<void> {
    botLogger.info("Status command requested", {
      userId: message.author.id,
      userTag: message.author.tag,
    });

    const voiceConnection = this.streamer.voiceConnection;
    const isConnected = !!voiceConnection;
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    let statusMessage = "📊 **Discord Stream Bot Status**\n";
    statusMessage += "```\n";
    statusMessage += `Bot User:     ${this.client.user?.tag}\n`;
    statusMessage += `Uptime:       ${hours}h ${minutes}m ${seconds}s\n`;
    statusMessage += `Voice:        ${isConnected ? "✅ Connected" : "❌ Disconnected"}\n`;
    statusMessage += `Streaming:    ${this.isStreaming ? "🔴 LIVE" : "⭕ Idle"}\n`;

    if (isConnected && voiceConnection) {
      statusMessage += `Channel:      #${voiceConnection.channelId}\n`;
    }

    if (this.isStreaming && this.currentStreamUrl) {
      statusMessage += `Stream URL:   ${this.currentStreamUrl.substring(0, 50)}${this.currentStreamUrl.length > 50 ? "..." : ""}\n`;
    }

    statusMessage += "```\n";
    statusMessage += "**📺 Stream Configuration**\n";
    statusMessage += "```yaml\n";
    statusMessage += `Resolution:   ${this.config.streamOpts.width}x${this.config.streamOpts.height}\n`;
    statusMessage += `Framerate:    ${this.config.streamOpts.fps} FPS\n`;
    statusMessage += `Bitrate:      ${this.config.streamOpts.bitrateKbps} kbps\n`;
    statusMessage += `Max Bitrate:  ${this.config.streamOpts.maxBitrateKbps} kbps\n`;
    statusMessage += `Codec:        ${this.config.streamOpts.videoCodec}\n`;
    statusMessage += `HW Accel:     ${this.config.streamOpts.hardwareAcceleration ? "Enabled" : "Disabled"}\n`;
    statusMessage += "```\n";

    statusMessage += `**🎮 Quick Commands**\n`;
    statusMessage += `• \`${this.commandPrefix}stream <url>\` - Start streaming (seamless switching)\n`;
    statusMessage += `• \`${this.commandPrefix}stop\` - Stop current stream\n`;
    statusMessage += `• \`${this.commandPrefix}help\` - View all commands`;

    await message.reply(statusMessage);
  }

  private async handleHelpCommand(message: any): Promise<void> {
    botLogger.info("Help command requested", {
      userId: message.author.id,
      userTag: message.author.tag,
    });

    const helpMessage = [
      "🎬 **Discord Video Stream Bot**",
      "*Streaming bot for Discord*\n",
      "**📝 Commands**",
      `• \`${this.commandPrefix}stream <url>\` - Start streaming (seamless switching if already streaming)`,
      `• \`${this.commandPrefix}stream --channel-id <id> <url>\` - Stream to specific channel`,
      `• \`${this.commandPrefix}stop\` - Stop current stream`,
      `• \`${this.commandPrefix}disconnect\` - Leave voice channel`,
      `• \`${this.commandPrefix}status\` - Show detailed status`,
      `• \`${this.commandPrefix}help\` - Show this help\n`,
      "**🔗 Supported Sources**",
      "• Direct video files (MP4, MKV, etc)",
      "• HTTP/HTTPS streams",
      "• HLS/DASH streams",
      "• RTMP streams\n",
      "**✨ Features**",
      "• Seamless stream switching without disconnecting",
      "• Hardware acceleration support",
      "• Real-time transcoding\n",
      `*Stream Bot v1.0.0 | ${this.config.streamOpts.videoCodec} codec*`,
    ].join("\n");

    await message.reply(helpMessage);
  }

  private cleanup(): void {
    if (this.currentController) {
      this.currentController.abort();
      delete this.currentController;
    }
    this.streamSwitcher?.cleanup();
    this.streamSwitcher = null;
    this.isStreaming = false;
    delete this.currentStreamUrl;
    if (this.streamer.voiceConnection) {
      this.streamer.leaveVoice();
    }
    this.client.destroy();
  }

  public async start(): Promise<void> {
    try {
      botLogger.info("Starting Discord Stream Bot...");
      await this.client.login(this.config.token);
    } catch (error) {
      botLogger.error("Failed to start bot", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// Main execution
async function main(): Promise<void> {
  try {
    botLogger.info("Discord Stream Bot starting up...", {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    });

    botLogger.info("Loading configuration...");
    const config = await loadConfig();

    botLogger.info("Configuration loaded successfully", {
      webhooksEnabled: config.allowWebhooks,
      streamResolution: `${config.streamOpts.width}x${config.streamOpts.height}`,
      streamFps: config.streamOpts.fps,
      streamBitrate: `${config.streamOpts.bitrateKbps}kbps`,
    });

    botLogger.info("Initializing bot...");
    const bot = new DiscordStreamBot(config);

    await bot.start();
  } catch (error) {
    botLogger.error("Fatal error during startup", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

main();
