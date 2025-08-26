import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, playStream } from "@dank074/discord-video-stream";
import { type BotConfig, validateStreamUrl } from "./config.js";
import { botLogger, streamLogger, discordLogger, logStreamStatus } from "./logger.js";
import { HealthProbeServer } from "./health.js";
import { detectNvidiaCapabilities, logHardwareAcceleration } from "./hardware.js";
import { StreamSwitcher } from "./stream-switcher.js";

export class DiscordStreamBot {
  private client: Client;
  private streamer: Streamer;
  private config: BotConfig;
  private currentController?: AbortController;
  private isStreaming = false;
  private currentStreamUrl?: string;
  private streamSwitcher?: StreamSwitcher | null;
  private currentPlayStreamController?: AbortController;
  private readonly commandPrefix: string;
  private healthProbeServer: HealthProbeServer | null = null;
  private lastStreamSwitchTime = 0;
  private readonly MIN_SWITCH_INTERVAL = 5000; // 5 seconds minimum between switches

  constructor(config: BotConfig) {
    this.config = config;
    this.commandPrefix = config.commandPrefix;
    this.client = new Client();
    this.streamer = new Streamer(this.client);

    // Initialize health probe server if enabled
    if (config.healthProbe?.enabled) {
      this.healthProbeServer = new HealthProbeServer(this.client, config.healthProbe);
    }
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
    this.client.on("ready", async () => {
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
      // Detect and log hardware acceleration capabilities
      await logHardwareAcceleration(this.config.streamOpts);
      botLogger.info("Bot configuration", {
        adaptiveStreaming: this.config.streamOpts.adaptiveSettings !== false,
        streamWidth: this.config.streamOpts.width || "adaptive",
        streamHeight: this.config.streamOpts.height || "adaptive",
        streamFps: this.config.streamOpts.fps || "adaptive",
        streamBitrate: this.config.streamOpts.bitrateKbps || "adaptive",
        hardwareAcceleration: this.config.streamOpts.hardwareAcceleration,
        videoCodec: this.config.streamOpts.videoCodec,
      });
    });

    this.client.on("messageCreate", async (message) => {
      // Filter out bots and optionally webhooks based on config
      if (message.author.bot && (!this.config.allowWebhooks || !message.webhookId)) return;

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

      await this.handleBotCommand(message);
    });

    this.client.on("error", (error) => {
      discordLogger.error("Discord client error", {
        error: error.message,
        stack: error.stack,
      });
    });

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      botLogger.warn("Received SIGINT, shutting down gracefully...");
      await this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      botLogger.warn("Received SIGTERM, shutting down gracefully...");
      await this.cleanup();
      process.exit(0);
    });
  }

  private async handleBotCommand(message: any): Promise<void> {
    const args = message.content.slice(this.commandPrefix.length).trim().split(/ +/);
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
            `❌ Unknown command. Use \`${this.commandPrefix}help\` for available commands.`
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

  private async handleStreamCommand(message: any, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply(
        `❌ Please provide a URL. Usage: \`${this.commandPrefix}stream [--channel-id <channel_id>] <url>\``
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
      await message.reply("❌ Invalid URL. Please provide a valid HTTP, HTTPS, or RTMP URL.");
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
        // Check rate limiting
        const now = Date.now();
        const timeSinceLastSwitch = now - this.lastStreamSwitchTime;
        if (timeSinceLastSwitch < this.MIN_SWITCH_INTERVAL) {
          const waitTime = this.MIN_SWITCH_INTERVAL - timeSinceLastSwitch;
          streamLogger.warn("Stream switch rate limited", {
            timeSinceLastSwitch,
            waitTime,
          });
          await message.reply(
            `⏳ Please wait ${Math.ceil(waitTime / 1000)} seconds before switching streams again.`
          );
          return;
        }

        this.lastStreamSwitchTime = now;

        streamLogger.info("Switching to new stream seamlessly", {
          oldStream: this.currentStreamUrl,
          newStream: url,
        });
        await message.reply("🔄 Switching to new stream...");

        try {
          // Switch stream source without stopping Discord stream
          await this.streamSwitcher.switchTo(url, this.currentController?.signal);
          this.currentStreamUrl = url;

          const successMsg = `✅ Switched to: \`${url}\` (${this.config.streamOpts.width}x${this.config.streamOpts.height}@${this.config.streamOpts.fps}fps, ${this.config.streamOpts.bitrateKbps}kbps)`;
          await message.reply(successMsg);

          streamLogger.info("Stream switch completed", {
            newStream: url,
          });
          return;
        } catch (error: any) {
          streamLogger.error("Failed to switch stream seamlessly, falling back to restart", {
            error: error.message,
            url,
          });
          await message.reply("⚠️ Seamless switch failed, restarting stream...");

          // Force reset the voice connection for parameter changes
          if (this.streamer.voiceConnection) {
            this.streamer.leaveVoice();
            await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait for disconnection
          }

          // Fall back to full restart
          if (this.currentController) {
            this.currentController.abort();
            delete this.currentController;
          }
          this.isStreaming = false;
          if (this.currentPlayStreamController) {
            this.currentPlayStreamController.abort();
            delete this.currentPlayStreamController;
          }
          this.streamSwitcher?.cleanup();
          this.streamSwitcher = null;
          delete this.currentStreamUrl;

          // Give time for cleanup
          await new Promise((resolve) => setTimeout(resolve, 3000));
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
        if (!targetChannel || !("joinable" in targetChannel) || !("speakable" in targetChannel)) {
          // Check if it's a voice-capable channel using duck typing
          await message.reply(`❌ Channel ID \`${channelId}\` is not a valid voice channel.`);
          return;
        }
        voiceChannel = targetChannel;

        botLogger.info("Using specified channel ID", {
          channelId: channelId,
          channelName: voiceChannel.name,
        });
      } catch (_error) {
        await message.reply(
          `❌ Could not find voice channel with ID \`${channelId}\`. Please check the channel ID.`
        );
        return;
      }
    } else {
      // Use user's current voice channel
      voiceChannel = message.author.voice?.channel;
      if (!voiceChannel) {
        await message.reply(
          "❌ You need to be in a voice channel first! Please join a voice channel or use `--channel-id <channel_id>` to specify one."
        );
        return;
      }
    }

    const statusMsg = await message.reply("🔄 Preparing to stream...");

    try {
      // Only join if not already in the target channel
      const currentConnection = this.streamer.voiceConnection;
      if (!currentConnection || currentConnection.channelId !== voiceChannel.id) {
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
      // Abort any existing streams completely
      if (this.currentController) {
        this.currentController.abort();
      }
      if (this.currentPlayStreamController) {
        this.currentPlayStreamController.abort();
      }

      // Clean up any existing stream switcher
      this.streamSwitcher?.cleanup();

      // Wait for Discord to properly reset after cleanup
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Create new controllers
      this.currentController = new AbortController();
      this.currentPlayStreamController = new AbortController();

      this.currentStreamUrl = url;
      streamLogger.info("Preparing stream", { url });

      // Create StreamSwitcher for seamless switching
      this.streamSwitcher = new StreamSwitcher(this.config);

      // Register stderr listener for stream monitoring before starting FFmpeg
      this.streamSwitcher.onStderr((line: string) => {
        // Log FFmpeg stderr for debugging
        streamLogger.debug("FFmpeg stderr", { line });
      });

      // Start initial stream
      await this.streamSwitcher.switchTo(url, this.currentController.signal);

      this.isStreaming = true;
      this.currentStreamUrl = url;

      // Update rate limiting timer for initial stream start
      this.lastStreamSwitchTime = Date.now();

      this.updatePresence();

      const successMsg = `✅ Started streaming: \`${url}\` (${this.config.streamOpts.width}x${this.config.streamOpts.height}@${this.config.streamOpts.fps}fps, ${this.config.streamOpts.bitrateKbps}kbps)`;
      await statusMsg?.edit(successMsg);

      logStreamStatus("starting", { url });

      // Start streaming with the StreamSwitcher output using dedicated playStream controller
      try {
        streamLogger.info("Starting Discord playStream", {
          url,
          hasExistingController: !!this.currentPlayStreamController,
          voiceConnectionId: this.streamer.voiceConnection?.channelId,
          isVoiceConnected: !!this.streamer.voiceConnection,
        });

        const playStreamPromise = playStream(
          this.streamSwitcher.getOutputStream(),
          this.streamer,
          {
            type: "go-live",
            readrateInitialBurst: 10, // For low latency
          },
          this.currentPlayStreamController.signal
        );

        // Add timeout to detect hanging playStream but let it continue in background
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            streamLogger.warn("PlayStream taking longer than expected, continuing in background");
            resolve();
          }, 30000);
        });

        // Attach FFmpeg process to health system for monitoring

        try {
          await Promise.race([
            playStreamPromise.then(() => {
              streamLogger.info("Discord playStream started successfully", {
                url,
              });
            }),
            timeoutPromise,
          ]);
        } catch (playStreamError: any) {
          streamLogger.warn("PlayStream had issues but continuing", {
            error: playStreamError.message,
          });
          // Don't abort - let playStream continue in background
        }
      } catch (playStreamError: any) {
        streamLogger.error("PlayStream error details", {
          error: playStreamError.message,
          errorName: playStreamError.name,
          url,
          isAbortError: playStreamError.name === "AbortError",
          voiceConnectionStatus: !!this.streamer.voiceConnection,
        });

        // Handle playStream errors gracefully
        if (playStreamError.name !== "AbortError") {
          streamLogger.warn("PlayStream failed, but FFmpeg stream is still running");
          // Don't try recovery - just log and continue
          return;
        } else {
          streamLogger.info("PlayStream was aborted during stream switch");
          return;
        }
      }
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

    // Stop both FFmpeg and Discord stream connections
    if (this.currentController) {
      this.currentController.abort();
    }
    if (this.currentPlayStreamController) {
      this.currentPlayStreamController.abort();
    }

    // Clean up stream switcher
    this.streamSwitcher?.cleanup();
    this.streamSwitcher = null;

    // Reset streaming state
    this.isStreaming = false;

    this.updatePresence();

    // Clean up controller references
    delete this.currentController;
    delete this.currentPlayStreamController;

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

    await message.reply("👋 Disconnected from voice channel and stopped streaming.");
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

    // Get basic bot status

    let statusMessage = "📊 **Discord Stream Bot Status**\n";
    statusMessage += "```\n";
    statusMessage += `Bot User:     ${this.client.user?.tag}\n`;
    statusMessage += `Uptime:       ${hours}h ${minutes}m ${seconds}s\n`;
    statusMessage += `Voice:        ${isConnected ? "✅ Connected" : "❌ Disconnected"}\n`;
    statusMessage += `Streaming:    ${this.isStreaming ? "🔴 LIVE" : "⭕ Idle"}\n`;
    statusMessage += `Health:       ${this.client.isReady() ? "✅ Ready" : "❌ Not Ready"}\n`;

    if (isConnected && voiceConnection) {
      statusMessage += `Channel:      #${voiceConnection.channelId}\n`;
    }

    if (this.isStreaming && this.currentStreamUrl) {
      statusMessage += `Stream URL:   ${this.currentStreamUrl.substring(0, 50)}${this.currentStreamUrl.length > 50 ? "..." : ""}\n`;
    }

    statusMessage += "```\n";
    statusMessage += "**📺 Stream Configuration**\n";
    statusMessage += "```yaml\n";
    const adaptiveMode = this.config.streamOpts.adaptiveSettings !== false;
    statusMessage += `Adaptive:     ${adaptiveMode ? "Enabled" : "Disabled"}\n`;
    if (!adaptiveMode) {
      statusMessage += `Resolution:   ${this.config.streamOpts.width || "N/A"}x${this.config.streamOpts.height || "N/A"}\n`;
      statusMessage += `Frame Rate:   ${this.config.streamOpts.fps || "N/A"} fps\n`;
      statusMessage += `Bitrate:      ${this.config.streamOpts.bitrateKbps || "N/A"} kbps\n`;
      statusMessage += `Max Bitrate:  ${this.config.streamOpts.maxBitrateKbps || "N/A"} kbps\n`;
    } else {
      statusMessage += `Resolution:   Auto (based on input)\n`;
      statusMessage += `Frame Rate:   Auto (based on input)\n`;
      statusMessage += `Bitrate:      Auto (optimized)\n`;
    }
    statusMessage += `Codec:        ${this.config.streamOpts.videoCodec}\n`;
    statusMessage += `HW Accel:     ${this.config.streamOpts.hardwareAcceleration ? "Enabled (NVENC)" : "Disabled"}\n`;
    statusMessage += "```\n";

    // Add hardware acceleration status if enabled
    if (this.config.streamOpts.hardwareAcceleration) {
      const nvidiaInfo = await detectNvidiaCapabilities();
      if (nvidiaInfo.available) {
        statusMessage += "\n**🎮 Hardware Acceleration**\n```\n";
        statusMessage += `GPU Count: ${nvidiaInfo.gpuCount}\n`;
        nvidiaInfo.gpuInfo.forEach((gpu, index) => {
          statusMessage += `GPU ${index + 1}: ${gpu}\n`;
        });
        statusMessage += "```\n";
      }
    }

    // Add health probe endpoints info
    if (this.healthProbeServer) {
      statusMessage += "\n**🏥 Health Endpoints**\n";
      statusMessage += `• \`/health\` - General health status\n`;
      statusMessage += `• \`/health/ready\` - Readiness probe\n`;
      statusMessage += `• \`/health/live\` - Liveness probe\n`;
      statusMessage += `• \`/health/startup\` - Startup probe\n`;
    }

    // Add basic system info
    statusMessage += "\n**💾 System Info**\n```\n";
    const memUsage = process.memoryUsage();
    statusMessage += `Memory Usage: ${(memUsage.rss / 1024 / 1024).toFixed(2)}MB\n`;
    statusMessage += `Process ID: ${process.pid}\n`;
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

  private async cleanup(): Promise<void> {
    botLogger.info("Starting bot cleanup...");

    try {
      // Stop health probe server
      if (this.healthProbeServer) {
        await this.healthProbeServer.stop();
        botLogger.info("Health probe server stopped");
      }
    } catch (error) {
      botLogger.error("Error stopping health probe server", error);
    }
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
      // Start health probe server first
      if (this.healthProbeServer) {
        await this.healthProbeServer.start();
        botLogger.info("Health probe server started successfully");
      }
    } catch (error) {
      botLogger.error("Failed to start health probe server", error);
      // Continue without health probe server if it fails
    }
    try {
      botLogger.info("Starting Discord Stream Bot...");
      await this.client.login(this.config.token);

      // Mark health probe as ready after successful login
      if (this.healthProbeServer) {
        this.healthProbeServer.markReady();
      }
    } catch (error) {
      botLogger.error("Failed to start bot", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
