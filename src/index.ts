import { Client, StageChannel } from "discord.js-selfbot-v13";
import { Streamer, playStream } from "@dank074/discord-video-stream";
import { loadConfig, validateStreamUrl, type BotConfig, type StreamConfig } from "./config.js";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "node:stream";
import {
  botLogger,
  streamLogger,
  discordLogger,
  logFFmpegOutput,
  logStreamStatus,
} from "./logger.js";
import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { HealthSystem } from "./health/index.js";

// Hardware acceleration detection
interface NvidiaInfo {
  available: boolean;
  gpuCount: number;
  gpuInfo: string[];
  nvencSupported: boolean;
}

// Stream analysis interfaces
interface StreamAnalysis {
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  codec?: string;
  duration?: number;
}

interface AdaptiveStreamSettings {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  maxBitrateKbps: number;
  hardwareAcceleration: boolean;
  videoCodec: string;
}

async function detectNvidiaCapabilities(): Promise<NvidiaInfo> {
  const result: NvidiaInfo = {
    available: false,
    gpuCount: 0,
    gpuInfo: [],
    nvencSupported: false,
  };

  try {
    // Check for NVIDIA devices in container (fallback method)
    // Check if NVIDIA devices are available
    const nvidiaDevices = ["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm"];

    let deviceCount = 0;
    for (const device of nvidiaDevices) {
      try {
        if (fs.existsSync(device)) {
          deviceCount++;
        }
      } catch {
        // Ignore individual device check failures
      }
    }

    if (deviceCount >= 2) {
      // At least nvidia0 and nvidiactl
      result.available = true;
      result.gpuCount = 1; // Assume 1 GPU for now
      result.gpuInfo = ["NVIDIA GPU (detected via device files)"];
    }

    // Check for NVENC support by testing ffmpeg encoders
    try {
      const ffmpegOutput = execSync("ffmpeg -hide_banner -encoders", {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      result.nvencSupported = ffmpegOutput.includes("h264_nvenc") || ffmpegOutput.includes("nvenc");
    } catch {
      result.nvencSupported = false;
    }
  } catch (error) {
    streamLogger.warn("NVIDIA GPU detection failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return result;
}

async function analyzeInputStream(url: string): Promise<StreamAnalysis> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-select_streams",
      "v:0",
      "-analyzeduration",
      "5000000",
      "-probesize",
      "5000000",
      url,
    ]);

    let output = "";
    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`));
        return;
      }

      try {
        const probe = JSON.parse(output);
        const videoStream = probe.streams[0];

        if (!videoStream) {
          reject(new Error("No video stream found"));
          return;
        }

        // Calculate FPS from various possible fields
        let fps = 30; // Default fallback
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
          if (den && den !== 0) fps = Math.round(num / den);
        } else if (videoStream.avg_frame_rate) {
          const [num, den] = videoStream.avg_frame_rate.split("/").map(Number);
          if (den && den !== 0) fps = Math.round(num / den);
        }

        // Sanitize FPS to reasonable values
        fps = Math.min(Math.max(fps, 15), 120);

        const analysis: StreamAnalysis = {
          width: videoStream.width || 1280,
          height: videoStream.height || 720,
          fps: fps,
          ...(videoStream.bit_rate && {
            bitrate: parseInt(videoStream.bit_rate, 10),
          }),
          ...(videoStream.codec_name && { codec: videoStream.codec_name }),
          ...(videoStream.duration && {
            duration: parseFloat(videoStream.duration),
          }),
        };

        streamLogger.info("Input stream analyzed", {
          originalResolution: `${analysis.width}x${analysis.height}`,
          originalFps: analysis.fps,
          originalCodec: analysis.codec,
          originalBitrate: analysis.bitrate
            ? `${Math.round(analysis.bitrate / 1000)}kbps`
            : "unknown",
        });

        resolve(analysis);
      } catch (error) {
        reject(new Error(`Failed to parse ffprobe output: ${error}`));
      }
    });

    ffprobe.on("error", (error) => {
      reject(new Error(`ffprobe error: ${error.message}`));
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      ffprobe.kill();
      reject(new Error("Stream analysis timed out"));
    }, 15000);
  });
}

function generateOptimalSettings(
  analysis: StreamAnalysis,
  hardwareAccel: boolean
): {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  maxBitrateKbps: number;
} {
  const { width, height, fps } = analysis;

  // Determine optimal resolution based on input - preserve 4K for hardware acceleration
  let targetWidth = width;
  let targetHeight = height;

  // Cap maximum resolution to 1440p for all streams above 1440p
  if (width > 2560 || height > 1440) {
    // Anything above 1440p -> cap to 1440p
    targetWidth = 2560;
    targetHeight = 1440;
  } else if (width > 1920 || height > 1080) {
    // 1080p+ -> keep original resolution
    targetWidth = width;
    targetHeight = height;
  }
  // Keep anything 1080p and below as-is

  // Ensure even dimensions for video encoding
  targetWidth = Math.floor(targetWidth / 2) * 2;
  targetHeight = Math.floor(targetHeight / 2) * 2;

  // Preserve high framerates for better motion
  let targetFps = Math.min(fps, 60);
  if (targetFps > 50) targetFps = 60;
  else if (targetFps > 40) targetFps = 50;
  else if (targetFps > 30) {
    // Keep original if between 30-40
  } else if (targetFps > 25) targetFps = 30;
  else targetFps = 25;

  // Calculate bitrate based on resolution and framerate
  const pixelCount = targetWidth * targetHeight;
  let baseBitrate: number;

  if (pixelCount >= 3686400) {
    // 1440p+
    baseBitrate = hardwareAccel ? 6000 : 4000;
  } else if (pixelCount >= 2073600) {
    // 1080p
    baseBitrate = hardwareAccel ? 4000 : 3000;
  } else if (pixelCount >= 921600) {
    // 720p
    baseBitrate = hardwareAccel ? 2500 : 2000;
  } else {
    // 480p and below
    baseBitrate = hardwareAccel ? 1500 : 1000;
  }

  // Adjust for framerate - higher FPS needs more bitrate
  let fpsMultiplier = 1.0;
  if (targetFps >= 50) {
    fpsMultiplier = 1.6; // 50-60 FPS needs significantly more bitrate
  } else if (targetFps > 30) {
    fpsMultiplier = 1.3; // 30+ FPS needs moderate increase
  }

  const targetBitrate = Math.round(baseBitrate * fpsMultiplier);
  const maxBitrate = Math.round(targetBitrate * 1.3); // Reduced from 1.5 to avoid excessive spikes

  streamLogger.info("Generated optimal settings", {
    inputResolution: `${width}x${height}`,
    outputResolution: `${targetWidth}x${targetHeight}`,
    inputFps: fps,
    outputFps: targetFps,
    bitrate: `${targetBitrate}kbps`,
    maxBitrate: `${maxBitrate}kbps`,
    hardwareAcceleration: hardwareAccel,
  });

  return {
    width: targetWidth,
    height: targetHeight,
    fps: targetFps,
    bitrateKbps: targetBitrate,
    maxBitrateKbps: maxBitrate,
  };
}

async function logHardwareAcceleration(config: StreamConfig): Promise<void> {
  if (!config.hardwareAcceleration) {
    streamLogger.info("Hardware acceleration disabled in config");
    return;
  }

  const nvidiaInfo = await detectNvidiaCapabilities();

  if (nvidiaInfo.available) {
    streamLogger.info("NVIDIA GPU detected for hardware acceleration", {
      gpuCount: nvidiaInfo.gpuCount,
      nvencSupported: nvidiaInfo.nvencSupported,
      gpus: nvidiaInfo.gpuInfo,
    });

    if (!nvidiaInfo.nvencSupported) {
      streamLogger.warn(
        "NVENC encoder not detected in FFmpeg - will fall back to software encoding"
      );
    }
  } else {
    streamLogger.warn("Hardware acceleration enabled but no NVIDIA GPU detected");
  }
}

class StreamSwitcher {
  private mainOutput: PassThrough;
  public currentCommand: any = null;
  private config: BotConfig;
  private stderrListeners: ((line: string) => void)[] = [];

  constructor(config: BotConfig) {
    this.mainOutput = new PassThrough();
    this.config = config;
  }

  public onStderr(callback: (line: string) => void): void {
    this.stderrListeners.push(callback);
  }

  public removeStderrListener(callback: (line: string) => void): void {
    const index = this.stderrListeners.indexOf(callback);
    if (index > -1) {
      this.stderrListeners.splice(index, 1);
    }
  }

  getOutputStream(): PassThrough {
    return this.mainOutput;
  }

  async switchTo(url: string, abortSignal?: AbortSignal): Promise<void> {
    streamLogger.info("Switching stream source", {
      newUrl: url,
      hasCurrentStream: !!this.currentCommand,
    });

    // Analyze input stream if adaptive settings are enabled
    let streamSettings: AdaptiveStreamSettings;

    if (this.config.streamOpts.adaptiveSettings !== false) {
      try {
        streamLogger.info("Analyzing input stream for adaptive settings...");
        const analysis = await analyzeInputStream(url);
        const optimalSettings = generateOptimalSettings(
          analysis,
          this.config.streamOpts.hardwareAcceleration || false
        );

        streamSettings = {
          ...optimalSettings,
          hardwareAcceleration: this.config.streamOpts.hardwareAcceleration || false,
          videoCodec: this.config.streamOpts.videoCodec || "H264",
        };
      } catch (error) {
        streamLogger.warn("Failed to analyze input stream, using fallback settings", {
          error: error instanceof Error ? error.message : String(error),
        });

        // Fallback to configured settings or defaults
        streamSettings = {
          width: this.config.streamOpts.width || 1280,
          height: this.config.streamOpts.height || 720,
          fps: this.config.streamOpts.fps || 30,
          bitrateKbps: this.config.streamOpts.bitrateKbps || 2000,
          maxBitrateKbps: this.config.streamOpts.maxBitrateKbps || 3000,
          hardwareAcceleration: this.config.streamOpts.hardwareAcceleration || false,
          videoCodec: this.config.streamOpts.videoCodec || "H264",
        };
      }
    } else {
      // Use configured settings when adaptive mode is disabled
      streamSettings = {
        width: this.config.streamOpts.width || 1280,
        height: this.config.streamOpts.height || 720,
        fps: this.config.streamOpts.fps || 30,
        bitrateKbps: this.config.streamOpts.bitrateKbps || 2000,
        maxBitrateKbps: this.config.streamOpts.maxBitrateKbps || 3000,
        hardwareAcceleration: this.config.streamOpts.hardwareAcceleration || false,
        videoCodec: this.config.streamOpts.videoCodec || "H264",
      };
    }

    // Create new FFmpeg command
    const newOutput = new PassThrough();
    const command = ffmpeg(url);

    // Log hardware acceleration status
    streamLogger.info(
      streamSettings.hardwareAcceleration
        ? "Attempting to initialize stream with NVIDIA hardware acceleration"
        : "Initializing stream with software encoding",
      {
        codec: streamSettings.videoCodec,
        resolution: `${streamSettings.width}x${streamSettings.height}`,
        fps: streamSettings.fps,
        bitrate: `${streamSettings.bitrateKbps}kbps`,
      }
    );

    // Basic input options - reduced buffering for lower latency
    const inputOptions = [
      "-re",
      "-analyzeduration",
      "2000000",
      "-probesize",
      "2000000",
      "-fflags",
      "+genpts",
    ];

    // Remove hardware decoding to avoid filter incompatibilities
    // Only use NVENC for encoding, not decoding

    command.inputOptions(inputOptions);

    // Configure video codec based on hardware acceleration
    let videoCodec = "libx264";
    let preset = "veryfast";

    if (streamSettings.hardwareAcceleration) {
      // Use NVIDIA NVENC hardware encoders
      if (streamSettings.videoCodec === "H264") {
        videoCodec = "h264_nvenc"; // NVIDIA hardware encoder
        preset = "p4"; // NVENC preset for balanced quality/speed
      } else if (streamSettings.videoCodec === "H265") {
        videoCodec = "hevc_nvenc";
        preset = "p4";
      }
    }

    // Output configuration - use matroska format (audio works properly with this)
    command
      .outputFormat("matroska")
      .videoCodec(videoCodec)
      .fps(streamSettings.fps)
      .videoBitrate(`${streamSettings.bitrateKbps}k`)
      .audioCodec("libopus")
      .audioChannels(2)
      .audioFrequency(48000)
      .audioBitrate("128k");

    // Add audio filter for better sync and low latency
    command.audioFilters("aresample=async=1");

    // Use CPU-based scaling for all cases to avoid filter issues
    command.size(`${streamSettings.width}x${streamSettings.height}`);

    // Configure output options based on hardware acceleration
    const outputOptions = [
      "-g",
      String(streamSettings.fps * 2),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-flush_packets",
      "1",
      "-max_delay",
      "0",
      "-avoid_negative_ts",
      "make_zero",
      "-thread_queue_size",
      "512",
      "-stats", // Enable progress statistics output
    ];

    if (streamSettings.hardwareAcceleration) {
      // NVIDIA NVENC specific options
      outputOptions.push(
        "-preset",
        preset,
        "-tune",
        "ll", // Low latency tuning for NVENC
        "-profile:v",
        "main",
        "-pix_fmt",
        "yuv420p",
        "-b_ref_mode",
        "0", // Disable B-frame reference for lower latency
        "-rc-lookahead",
        "4", // Further reduced lookahead for lower latency
        "-gpu",
        "0", // Use first GPU
        "-strict_gop",
        "1",
        "-delay",
        "0", // Minimize encoding delay
        "-zerolatency",
        "1" // Enable zero latency mode
      );
    } else {
      // Software encoding options
      outputOptions.push(
        "-preset",
        preset,
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "baseline",
        "-level",
        "3.1",
        "-strict_gop",
        "1",
        "-max_delay",
        "0",
        "-rc-lookahead",
        "0" // No lookahead for software encoding
      );
    }

    command.outputOptions(outputOptions);

    command.output(newOutput);

    // Forward FFmpeg output to both logger and stream monitor
    command.on("stderr", (line) => {
      logFFmpegOutput(line);

      // Forward to all stderr listeners (including stream monitor)
      this.stderrListeners.forEach((callback) => {
        try {
          callback(line);
        } catch (error) {
          streamLogger.error("Error in stderr listener", { error });
        }
      });
    });

    // Handle FFmpeg errors
    command.on("error", (error) => {
      if (!error.message.includes("signal 15") && !error.message.includes("code 255")) {
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
      { once: true }
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

    // For matroska format, ensure complete cleanup to prevent container corruption
    const oldCommand = this.currentCommand;
    if (oldCommand) {
      streamLogger.info("Performing thorough cleanup for stable stream switch");

      // Stop old command completely and wait for full cleanup
      try {
        oldCommand.kill("SIGTERM");
        // Extended wait for matroska container to properly close
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error: any) {
        streamLogger.warn("Error killing old FFmpeg process", {
          error: error.message,
        });
      }

      // Additional wait to ensure no lingering processes or data
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Update current command reference
    this.currentCommand = command;

    // Set up data forwarding from new stream to main output
    let dataCount = 0;
    newOutput.on("data", (chunk) => {
      if (!this.mainOutput.destroyed) {
        dataCount++;
        if (dataCount % 1000 === 0) {
          streamLogger.info("Stream data flowing", {
            url,
            chunkSize: chunk.length,
            totalChunks: dataCount,
          });
        }
        try {
          this.mainOutput.write(chunk);
        } catch (error: any) {
          streamLogger.error("Error writing to main output", {
            error: error.message,
            url,
          });
        }
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
  private currentPlayStreamController?: AbortController;
  private readonly commandPrefix: string;
  private healthSystem: HealthSystem;

  constructor(config: BotConfig) {
    this.config = config;
    this.commandPrefix = config.commandPrefix;
    this.client = new Client();
    this.streamer = new Streamer(this.client);

    // Initialize health system with config
    this.healthSystem = new HealthSystem(this.client, this.streamer, config.health);
    this.setupHealthEventHandlers();
    this.setupEventHandlers();
  }

  private setupHealthEventHandlers(): void {
    this.healthSystem.on("recovery-started", (actions) => {
      botLogger.warn("Auto-recovery triggered", { actions });
    });

    this.healthSystem.on("recovery-completed", (results) => {
      const successful = results.filter((r) => r.success).length;
      botLogger.info("Auto-recovery completed", {
        successful,
        total: results.length,
      });
    });

    this.healthSystem.on("stream-quality-alert", (alert) => {
      botLogger.warn("Stream quality degraded", {
        severity: alert.severity,
        status: alert.status.status,
        issues: alert.status.issues,
      });
    });

    // Handle voice disconnection events
    this.healthSystem.on("voice-disconnected", () => {
      botLogger.warn("Voice connection lost - cleaning up stream");

      // Stop current stream
      if (this.currentController) {
        this.currentController.abort();
        delete this.currentController;
      }

      if (this.currentPlayStreamController) {
        this.currentPlayStreamController.abort();
        delete this.currentPlayStreamController;
      }

      // Clean up stream switcher
      this.streamSwitcher?.cleanup();
      this.streamSwitcher = null;

      // Update streaming state
      this.isStreaming = false;
      delete this.currentStreamUrl;

      // Update bot presence
      this.updatePresence();

      botLogger.info("Stream cleanup completed due to voice disconnection");
    });

    this.healthSystem.on("critical-error", (error) => {
      botLogger.error("Critical system error detected", error);
    });
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

          // Notify health system about stream stopping
          this.healthSystem.onStreamStopped();

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

        // Notify health system about stream stopping
        this.healthSystem.onStreamStopped();

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
        this.healthSystem.onFFmpegStderr(line);
      });

      // Start initial stream
      await this.streamSwitcher.switchTo(url, this.currentController.signal);

      this.isStreaming = true;
      this.currentStreamUrl = url;

      // Notify health system about stream starting
      this.healthSystem.onStreamStarted(url, channelId || undefined, this.currentController);

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
          }, 5000);
        });

        // Attach FFmpeg process to health system for monitoring
        if (this.streamSwitcher?.currentCommand) {
          this.healthSystem.onFFmpegProcess(this.streamSwitcher.currentCommand);
        }

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
          // The stream data is flowing, just Discord display failed
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

    // Notify health system about stream stopping
    this.healthSystem.onStreamStopped();

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

    // Get health system status
    const healthStatus = this.healthSystem.getSystemStatus();
    const metrics = this.healthSystem.getMetrics();

    let statusMessage = "📊 **Discord Stream Bot Status**\n";
    statusMessage += "```\n";
    statusMessage += `Bot User:     ${this.client.user?.tag}\n`;
    statusMessage += `Uptime:       ${hours}h ${minutes}m ${seconds}s\n`;
    statusMessage += `Voice:        ${isConnected ? "✅ Connected" : "❌ Disconnected"}\n`;
    statusMessage += `Streaming:    ${this.isStreaming ? "🔴 LIVE" : "⭕ Idle"}\n`;
    statusMessage += `Health:       ${healthStatus.healthy ? "✅ Healthy" : healthStatus.ready ? "⚠️ Degraded" : "❌ Unhealthy"}\n`;

    if (isConnected && voiceConnection) {
      statusMessage += `Channel:      #${voiceConnection.channelId}\n`;
    }

    if (this.isStreaming && this.currentStreamUrl) {
      statusMessage += `Stream URL:   ${this.currentStreamUrl.substring(0, 50)}${this.currentStreamUrl.length > 50 ? "..." : ""}\n`;

      // Add stream quality info
      const streamQuality = this.healthSystem.getStreamQuality();
      if (streamQuality && streamQuality.status !== "excellent") {
        statusMessage += `Stream Quality: ${streamQuality.status.toUpperCase()} (${streamQuality.score}/100)\n`;
      }
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

    // Add health system endpoints info
    statusMessage += "\n**🏥 Health Endpoints**\n";
    statusMessage += `• \`/health\` - General health check\n`;
    statusMessage += `• \`/health/live\` - Liveness probe\n`;
    statusMessage += `• \`/health/ready\` - Readiness probe\n`;
    statusMessage += `• \`/health/detailed\` - Detailed health info\n`;

    // Add system health summary
    statusMessage += "\n**🏥 System Health**\n```\n";
    statusMessage += `Memory Usage: ${(metrics.memoryUsage.rss / 1024 / 1024).toFixed(2)}MB\n`;
    statusMessage += `CPU Usage: ${metrics.cpuUsage.toFixed(1)}%\n`;
    statusMessage += `Errors: ${metrics.errorCount}\n`;
    statusMessage += `Auto-Recovery: ${healthStatus.components.recovery ? "✅ Ready" : "⚠️ Active"}\n`;
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
      // Stop health system
      await this.healthSystem.stop();
      botLogger.info("Health system stopped");
    } catch (error) {
      botLogger.error("Error stopping health system", error);
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
      // Start health system first
      await this.healthSystem.start();
      botLogger.info("Health system started successfully");
    } catch (error) {
      botLogger.error("Failed to start health system", error);
      // Continue without health system if it fails
    }
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
