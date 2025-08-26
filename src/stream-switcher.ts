import { PassThrough } from "node:stream";
import ffmpeg from "fluent-ffmpeg";
import type { BotConfig } from "./config.js";
import { streamLogger, logFFmpegOutput } from "./logger.js";
import { analyzeInputStream, generateOptimalSettings } from "./stream-analysis.js";
import type { AdaptiveStreamSettings } from "./types.js";

export class StreamSwitcher {
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
          width: this.config.streamOpts.width || 1920,
          height: this.config.streamOpts.height || 1080,
          fps: this.config.streamOpts.fps || 60,
          bitrateKbps: this.config.streamOpts.bitrateKbps || 4000,
          maxBitrateKbps: this.config.streamOpts.maxBitrateKbps || 6000,
          hardwareAcceleration: this.config.streamOpts.hardwareAcceleration || false,
          videoCodec: this.config.streamOpts.videoCodec || "H264",
        };
      }
    } else {
      // Use configured settings when adaptive mode is disabled
      streamSettings = {
        width: this.config.streamOpts.width || 1920,
        height: this.config.streamOpts.height || 1080,
        fps: this.config.streamOpts.fps || 60,
        bitrateKbps: this.config.streamOpts.bitrateKbps || 4000,
        maxBitrateKbps: this.config.streamOpts.maxBitrateKbps || 6000,
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

    // Output configuration - use matroska format with minimal flags
    command.outputOptions("-fflags", "nobuffer");
    command.outputOptions("-flush_packets", "1");

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
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof", // Optimize for live streaming
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

    // Cleanup old command if exists
    const oldCommand = this.currentCommand;
    if (oldCommand) {
      streamLogger.info("Performing cleanup for stream switch");

      // Stop old command and wait for cleanup
      try {
        oldCommand.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        streamLogger.warn("Error killing old FFmpeg process", {
          error: error.message,
        });
      }

      // Additional wait
      await new Promise((resolve) => setTimeout(resolve, 200));
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
