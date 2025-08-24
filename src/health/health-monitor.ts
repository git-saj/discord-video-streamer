import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import type { Client } from "discord.js-selfbot-v13";
import type { Streamer } from "@dank074/discord-video-stream";
import { botLogger as logger } from "../logger.js";

const execAsync = promisify(exec);

export interface HealthMetrics {
  // System Health
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: number;

  // Discord Connection
  discordConnected: boolean;
  discordLatency: number;
  discordReady: boolean;

  // Voice Connection
  voiceConnected: boolean;
  voiceChannelId?: string;
  voiceLatency?: number;

  // Streaming Status
  isStreaming: boolean;
  streamUrl?: string;
  streamDuration?: number;
  streamStartTime?: Date;

  // FFmpeg Process
  ffmpegRunning: boolean;
  ffmpegPid?: number;
  ffmpegCpuUsage?: number;
  ffmpegMemoryUsage?: number;

  // Stream Quality Metrics
  currentBitrate?: number;
  frameRate?: number;
  droppedFrames?: number;
  encodingSpeed?: number;

  // Hardware Status
  gpuAvailable: boolean;
  gpuUtilization?: number;
  gpuMemoryUsed?: number;

  // Error Tracking
  lastError: string | undefined;
  errorCount: number;
  warningCount: number;

  // Performance
  averageResponseTime: number;
  peakMemoryUsage: number;

  timestamp: Date;
}

export interface HealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    [key: string]: {
      status: "pass" | "warn" | "fail";
      message: string;
      duration?: number;
    };
  };
  timestamp: Date;
}

export class HealthMonitor extends EventEmitter {
  private client: Client;
  private streamer: Streamer;
  private metrics: HealthMetrics;
  private checkInterval?: NodeJS.Timeout;
  private metricsInterval?: NodeJS.Timeout;
  private startTime: Date;
  private responseTimes: number[] = [];
  private maxResponseTimes = 100; // Keep last 100 response times
  private errorCount = 0;
  private warningCount = 0;
  private lastStreamCheck = 0;
  private healthSystem?: any;
  private streamQualityHistory: Array<{
    bitrate: number | undefined;
    fps: number | undefined;
    timestamp: Date;
  }> = [];
  private lastStreamStartTime?: Date;
  private streamTransitionGracePeriodMs = 30000; // 30 seconds

  constructor(client: Client, streamer: Streamer, healthSystem?: any) {
    super();
    this.client = client;
    this.streamer = streamer;
    this.healthSystem = healthSystem;
    this.startTime = new Date();

    this.metrics = this.initializeMetrics();
    this.setupEventListeners();
  }

  private initializeMetrics(): HealthMetrics {
    return {
      uptime: 0,
      memoryUsage: process.memoryUsage(),
      cpuUsage: 0,
      discordConnected: false,
      discordLatency: 0,
      discordReady: false,
      voiceConnected: false,
      isStreaming: false,
      ffmpegRunning: false,
      gpuAvailable: false,
      lastError: undefined,
      errorCount: 0,
      warningCount: 0,
      averageResponseTime: 0,
      peakMemoryUsage: 0,
      timestamp: new Date(),
    };
  }

  private setupEventListeners(): void {
    // Discord events
    this.client.on("ready", () => {
      this.metrics.discordReady = true;
      this.metrics.discordConnected = true;
      logger.info("Health monitor: Discord connected");
    });

    this.client.on("disconnect", () => {
      this.metrics.discordConnected = false;
      this.metrics.discordReady = false;
      this.errorCount++;
      logger.warn("Health monitor: Discord disconnected");
      this.emit("discord-disconnected");
    });

    // Voice state change events
    this.client.on("voiceStateUpdate", (oldState, newState) => {
      // Check if this is about our bot user
      if (newState.member?.user.id === this.client.user?.id) {
        const wasConnected = !!oldState.channel;
        const isConnected = !!newState.channel;

        if (wasConnected && !isConnected) {
          // Bot was disconnected from voice channel
          logger.warn("Health monitor: Bot disconnected from voice channel", {
            oldChannelId: oldState.channelId,
            reason: "disconnected",
          });

          // Update voice connection status
          this.metrics.voiceConnected = false;
          delete this.metrics.voiceChannelId;

          // If we were streaming, we should stop
          if (this.metrics.isStreaming) {
            this.metrics.isStreaming = false;
            logger.warn("Stream status updated to false due to voice disconnection");
          }

          this.emit("voice-disconnected");
        } else if (!wasConnected && isConnected) {
          // Bot connected to voice channel
          logger.info("Health monitor: Bot connected to voice channel", {
            channelId: newState.channelId,
          });
          this.metrics.voiceConnected = true;
          if (newState.channelId) {
            this.metrics.voiceChannelId = newState.channelId;
          }
        }
      }
    });

    this.client.on("error", (error) => {
      this.errorCount++;
      this.metrics.lastError = error.message;
      logger.error("Health monitor: Discord error", error);
      this.emit("discord-error", error);
    });

    this.client.on("warn", (warning) => {
      this.warningCount++;
      logger.warn("Health monitor: Discord warning", warning);
    });

    // Process events
    process.on("uncaughtException", (error) => {
      this.errorCount++;
      this.metrics.lastError = error.message;
      logger.error("Health monitor: Uncaught exception", error);
      this.emit("critical-error", error);
    });

    process.on("unhandledRejection", (error) => {
      this.errorCount++;
      this.metrics.lastError = error?.toString();
      logger.error("Health monitor: Unhandled rejection", error);
      this.emit("critical-error", error);
    });
  }

  public start(checkIntervalMs = 30000, metricsIntervalMs = 5000): void {
    logger.info("Starting health monitor", {
      checkInterval: checkIntervalMs,
      metricsInterval: metricsIntervalMs,
    });

    // Start periodic health checks
    this.checkInterval = setInterval(() => {
      this.performHealthCheck().catch((error) => {
        logger.error("Health check failed", error);
        this.emit("health-check-error", error);
      });
    }, checkIntervalMs);

    // Start periodic metrics collection
    this.metricsInterval = setInterval(() => {
      this.collectMetrics().catch((error) => {
        logger.error("Metrics collection failed", error);
      });
    }, metricsIntervalMs);

    // Initial metrics collection
    this.collectMetrics().catch((error) => {
      logger.error("Initial metrics collection failed", error);
    });
  }

  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined as any;
    }

    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined as any;
    }

    logger.info("Health monitor stopped");
  }

  private async collectMetrics(): Promise<void> {
    const startTime = performance.now();

    try {
      // Basic system metrics
      this.metrics.uptime = Date.now() - this.startTime.getTime();
      this.metrics.memoryUsage = process.memoryUsage();
      this.metrics.cpuUsage = await this.getCpuUsage();

      // Track peak memory usage
      if (this.metrics.memoryUsage.rss > this.metrics.peakMemoryUsage) {
        this.metrics.peakMemoryUsage = this.metrics.memoryUsage.rss;
      }

      // Discord metrics
      this.metrics.discordConnected = this.client.readyAt !== null;
      this.metrics.discordReady = this.client.readyAt !== null;
      this.metrics.discordLatency = this.client.ws.ping;

      // Voice connection metrics - check actual connection state
      const voiceConnection = this.streamer.voiceConnection;

      // More robust check: ensure WebSocket is connected and not closed
      const hasValidWebSocket = voiceConnection?.ws && voiceConnection.ws.readyState === 1; // WebSocket.OPEN = 1

      const hasValidStatus =
        voiceConnection?.status &&
        voiceConnection.status.started &&
        voiceConnection.status.hasSession &&
        voiceConnection.status.hasToken;

      const isActuallyConnected = voiceConnection && hasValidWebSocket && hasValidStatus;

      this.metrics.voiceConnected = !!isActuallyConnected;
      if (isActuallyConnected) {
        this.metrics.voiceChannelId = voiceConnection.channelId;
        this.metrics.voiceLatency = 0; // Voice latency not available in this API
      } else {
        delete this.metrics.voiceChannelId;
        this.metrics.voiceLatency = 0;
      }

      // Streaming metrics
      this.metrics.isStreaming = this.isCurrentlyStreaming();
      if (this.metrics.isStreaming) {
        await this.collectStreamingMetrics();
      }

      // FFmpeg process metrics
      await this.collectFFmpegMetrics();

      // GPU metrics if available
      await this.collectGpuMetrics();

      // Error tracking
      this.metrics.errorCount = this.errorCount;
      this.metrics.warningCount = this.warningCount;

      // Performance metrics
      const responseTime = performance.now() - startTime;
      this.addResponseTime(responseTime);
      this.metrics.averageResponseTime = this.getAverageResponseTime();

      this.metrics.timestamp = new Date();

      // Emit metrics update
      this.emit("metrics-updated", this.metrics);
    } catch (error) {
      logger.error("Error collecting metrics", error);
      this.errorCount++;
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async performHealthCheck(): Promise<HealthCheckResult> {
    const startTime = performance.now();
    const checks: HealthCheckResult["checks"] = {};

    // Discord connection check
    try {
      const discordStart = performance.now();
      const connected = this.client.readyAt !== null && this.client.ws.ping >= 0;
      const discordDuration = performance.now() - discordStart;

      checks.discord = {
        status: connected ? "pass" : "fail",
        message: connected
          ? `Connected (ping: ${this.client.ws.ping}ms)`
          : "Not connected to Discord",
        duration: discordDuration,
      };
    } catch (error) {
      checks.discord = {
        status: "fail",
        message: `Discord check failed: ${error}`,
      };
    }

    // Voice connection check
    try {
      const voiceStart = performance.now();
      const voiceConnection = this.streamer.voiceConnection;

      // Use the same robust check as metrics collection
      const hasValidWebSocket = voiceConnection?.ws && voiceConnection.ws.readyState === 1; // WebSocket.OPEN = 1

      const hasValidStatus =
        voiceConnection?.status &&
        voiceConnection.status.started &&
        voiceConnection.status.hasSession &&
        voiceConnection.status.hasToken;

      const isActuallyConnected = voiceConnection && hasValidWebSocket && hasValidStatus;
      const voiceDuration = performance.now() - voiceStart;

      checks.voice = {
        status: isActuallyConnected ? "pass" : "warn",
        message: isActuallyConnected
          ? `Connected to channel ${voiceConnection.channelId}`
          : "Not connected to voice",
        duration: voiceDuration,
      };
    } catch (error) {
      checks.voice = {
        status: "fail",
        message: `Voice check failed: ${error}`,
      };
    }

    // Memory usage check
    const memUsage = process.memoryUsage();
    const memUsageMB = memUsage.rss / 1024 / 1024;
    const memoryThreshold = 1000; // 1GB threshold

    checks.memory = {
      status: memUsageMB > memoryThreshold ? "warn" : "pass",
      message: `${memUsageMB.toFixed(2)}MB used${memUsageMB > memoryThreshold ? " (high usage)" : ""}`,
    };

    // Stream health check (if streaming)
    if (this.metrics.isStreaming) {
      try {
        const streamStart = performance.now();
        const streamHealthy = await this.checkStreamHealth();
        const streamDuration = performance.now() - streamStart;

        checks.stream = {
          status: streamHealthy ? "pass" : "fail",
          message: streamHealthy ? "Stream is healthy" : "Stream issues detected",
          duration: streamDuration,
        };
      } catch (error) {
        checks.stream = {
          status: "fail",
          message: `Stream check failed: ${error}`,
        };
      }
    }

    // FFmpeg process check
    try {
      const ffmpegStart = performance.now();
      const ffmpegHealthy = await this.checkFFmpegHealth();
      const ffmpegDuration = performance.now() - ffmpegStart;

      checks.ffmpeg = {
        status: ffmpegHealthy ? "pass" : "warn",
        message: ffmpegHealthy ? "FFmpeg processes healthy" : "No FFmpeg processes detected",
        duration: ffmpegDuration,
      };
    } catch (error) {
      checks.ffmpeg = {
        status: "fail",
        message: `FFmpeg check failed: ${error}`,
      };
    }

    // Overall status determination
    const failCount = Object.values(checks).filter((c) => c.status === "fail").length;
    const warnCount = Object.values(checks).filter((c) => c.status === "warn").length;

    let overallStatus: HealthCheckResult["status"] = "healthy";
    if (failCount > 0) {
      overallStatus = "unhealthy";
    } else if (warnCount > 0) {
      overallStatus = "degraded";
    }

    const result: HealthCheckResult = {
      status: overallStatus,
      checks,
      timestamp: new Date(),
    };

    logger.debug("Health check completed", {
      status: overallStatus,
      duration: performance.now() - startTime,
      checks: Object.keys(checks).length,
    });

    this.emit("health-check-completed", result);
    return result;
  }

  private async getCpuUsage(): Promise<number> {
    try {
      const { stdout } = await execAsync("ps -p $PPID -o %cpu --no-headers");
      return parseFloat(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  private isCurrentlyStreaming(): boolean {
    // Check if there's an actual active voice connection
    const voiceConnection = this.streamer.voiceConnection;

    const hasValidWebSocket = voiceConnection?.ws && voiceConnection.ws.readyState === 1; // WebSocket.OPEN = 1

    const hasValidStatus =
      voiceConnection?.status &&
      voiceConnection.status.started &&
      voiceConnection.status.hasSession &&
      voiceConnection.status.hasToken;

    const hasActiveConnection = voiceConnection && hasValidWebSocket && hasValidStatus;

    // Only consider streaming if we have both connection and FFmpeg running
    return !!hasActiveConnection && this.metrics.ffmpegRunning;
  }

  private async collectStreamingMetrics(): Promise<void> {
    // Collect streaming-specific metrics
    // This would integrate with your FFmpeg processes to get real-time stats
    const now = Date.now();
    if (now - this.lastStreamCheck > 5000) {
      // Check every 5 seconds
      // Get actual stream quality metrics from stream monitor
      const streamMetrics = this.healthSystem?.streamMonitor?.getCurrentMetrics();

      this.streamQualityHistory.push({
        timestamp: new Date(),
        bitrate: streamMetrics?.bitrate || undefined,
        fps: streamMetrics?.frameRate || undefined,
      });

      // Keep only last 60 entries (5 minutes of data)
      if (this.streamQualityHistory.length > 60) {
        this.streamQualityHistory = this.streamQualityHistory.slice(-60);
      }

      this.lastStreamCheck = now;
    }
  }

  private async collectFFmpegMetrics(): Promise<void> {
    try {
      // Check for running FFmpeg processes
      const { stdout } = await execAsync("pgrep -f ffmpeg || echo ''");
      const pids = stdout
        .trim()
        .split("\n")
        .filter((pid) => pid);

      this.metrics.ffmpegRunning = pids.length > 0;
      if (pids.length > 0) {
        this.metrics.ffmpegPid = parseInt(pids[0], 10);

        // Get CPU and memory usage for the first FFmpeg process
        try {
          const { stdout: psOutput } = await execAsync(
            `ps -p ${pids[0]} -o %cpu,%mem --no-headers`
          );
          const [cpu, mem] = psOutput.trim().split(/\s+/).map(parseFloat);
          this.metrics.ffmpegCpuUsage = cpu || 0;
          this.metrics.ffmpegMemoryUsage = mem || 0;
        } catch {
          // Process might have ended, that's okay
        }
      }
    } catch {
      this.metrics.ffmpegRunning = false;
    }
  }

  private async collectGpuMetrics(): Promise<void> {
    try {
      // Check if nvidia-smi is available
      const { stdout } = await execAsync(
        "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits"
      );
      const lines = stdout.trim().split("\n");
      if (lines.length > 0) {
        const [utilization, memUsed] = lines[0].split(",").map((s) => parseInt(s.trim(), 10));
        this.metrics.gpuAvailable = true;
        this.metrics.gpuUtilization = utilization;
        this.metrics.gpuMemoryUsed = memUsed;
      }
    } catch {
      this.metrics.gpuAvailable = false;
    }
  }

  private async checkStreamHealth(): Promise<boolean> {
    // During stream startup/transition grace period, be more lenient
    const isInGracePeriod =
      this.lastStreamStartTime &&
      Date.now() - this.lastStreamStartTime.getTime() < this.streamTransitionGracePeriodMs;

    if (isInGracePeriod) {
      logger.debug("Stream health check during grace period", {
        graceTimeRemaining:
          this.streamTransitionGracePeriodMs -
          (this.lastStreamStartTime ? Date.now() - this.lastStreamStartTime.getTime() : 0),
        ffmpegRunning: this.metrics.ffmpegRunning,
      });

      // During grace period, only fail if we're sure there's a real problem
      // Allow FFmpeg to be temporarily not detected during transitions
      return true;
    }

    // Normal operation - apply stricter checks
    if (!this.metrics.ffmpegRunning) {
      return false;
    }

    // Check for recent quality metrics
    const recentMetrics = this.streamQualityHistory.slice(-3);
    if (recentMetrics.length === 0) {
      return true; // No metrics yet, assume healthy
    }

    // Check if bitrate is consistently 0 (indicates stream issues)
    const zeroBitrateCount = recentMetrics.filter((m) => (m.bitrate || 0) === 0).length;
    if (zeroBitrateCount >= 2) {
      return false;
    }

    return true;
  }

  private async checkFFmpegHealth(): Promise<boolean> {
    // During stream startup/transition grace period, be more lenient
    const isInGracePeriod =
      this.lastStreamStartTime &&
      Date.now() - this.lastStreamStartTime.getTime() < this.streamTransitionGracePeriodMs;

    if (isInGracePeriod) {
      // During grace period, assume FFmpeg is healthy even if not detected yet
      return true;
    }

    return this.metrics.ffmpegRunning;
  }

  private addResponseTime(time: number): void {
    this.responseTimes.push(time);
    if (this.responseTimes.length > this.maxResponseTimes) {
      this.responseTimes.shift();
    }
  }

  private getAverageResponseTime(): number {
    if (this.responseTimes.length === 0) return 0;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return sum / this.responseTimes.length;
  }

  public getMetrics(): HealthMetrics {
    return { ...this.metrics };
  }

  public async getCurrentHealthStatus(): Promise<HealthCheckResult> {
    return this.performHealthCheck();
  }

  public getStreamQualityHistory(): Array<{
    bitrate: number | undefined;
    fps: number | undefined;
    timestamp: Date;
  }> {
    return [...this.streamQualityHistory];
  }

  // Helper methods for external health checks
  public notifyStreamStarted(): void {
    this.lastStreamStartTime = new Date();
    logger.debug("Stream start notification received by health monitor", {
      timestamp: this.lastStreamStartTime.toISOString(),
      gracePeriodMs: this.streamTransitionGracePeriodMs,
    });
  }

  public isHealthy(): boolean {
    return (
      this.metrics.discordConnected &&
      this.metrics.errorCount < 10 && // Allow some errors
      this.metrics.memoryUsage.rss < 2 * 1024 * 1024 * 1024
    ); // 2GB limit
  }

  public isReady(): boolean {
    return this.metrics.discordReady;
  }

  public isLive(): boolean {
    return this.isReady() && !this.hasCriticalErrors();
  }

  private hasCriticalErrors(): boolean {
    return (
      this.metrics.errorCount > 20 || // Too many errors
      !this.metrics.discordConnected || // Discord disconnected
      this.metrics.memoryUsage.rss > 3 * 1024 * 1024 * 1024
    ); // 3GB critical limit
  }
}
