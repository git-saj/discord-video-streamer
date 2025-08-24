import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { streamLogger as logger } from "../logger.js";

export interface StreamQualityMetrics {
  // Basic stream info
  streamUrl: string | undefined;
  streamStartTime?: Date;
  streamDuration: number;

  // Video metrics
  frameRate: number;
  bitrate: number; // kbps
  resolution: {
    width: number;
    height: number;
  };

  // Quality indicators
  droppedFrames: number;
  duplicateFrames: number;
  encodingSpeed: number; // multiplier (1x = realtime)

  // Network metrics
  networkLatency?: number;
  packetLoss?: number;
  bandwidth: number; // kbps

  // Performance metrics
  cpuUsage: number;
  memoryUsage: number;
  gpuUsage?: number;

  // Error tracking
  errorCount: number;
  warningCount: number;
  lastError?: string;

  // Buffer health
  bufferHealth: "good" | "warning" | "critical";
  bufferSize?: number;

  timestamp: Date;
}

export interface StreamHealthStatus {
  status: "excellent" | "good" | "degraded" | "poor" | "critical";
  score: number; // 0-100
  issues: string[];
  recommendations: string[];
  timestamp: Date;
}

export interface FFmpegStats {
  frame: number;
  fps: number;
  q: number; // quality
  size: string;
  time: string;
  bitrate: string;
  speed: string;
  dup?: number;
  drop?: number;
}

export class StreamMonitor extends EventEmitter {
  private currentMetrics: StreamQualityMetrics;
  private metricsHistory: StreamQualityMetrics[] = [];
  private ffmpegProcess?: ChildProcess;
  private monitorInterval?: NodeJS.Timeout;
  private qualityCheckInterval?: NodeJS.Timeout;
  private streamStartTime?: Date;
  private lastStatsUpdate = 0;
  private consecutivePoorQuality = 0;
  private isMonitoring = false;
  private isInStartupPhase = false;
  private startupGracePeriodMs = 60000; // 60 seconds
  private streamEndTime?: Date;
  private isStreamEnded = false;
  private staleStreamTimeoutMs = 30000; // 30 seconds

  // Quality thresholds
  private readonly qualityThresholds = {
    excellent: { fps: 58, bitrate: 8000, droppedFrames: 0, speed: 0.98 },
    good: { fps: 55, bitrate: 6000, droppedFrames: 5, speed: 0.95 },
    degraded: { fps: 45, bitrate: 4000, droppedFrames: 20, speed: 0.9 },
    poor: { fps: 30, bitrate: 2000, droppedFrames: 50, speed: 0.8 },
  };

  constructor() {
    super();
    this.currentMetrics = this.initializeMetrics();
  }

  private initializeMetrics(): StreamQualityMetrics {
    return {
      streamUrl: undefined,
      streamDuration: 0,
      frameRate: 0,
      bitrate: 0,
      resolution: { width: 0, height: 0 },
      droppedFrames: 0,
      duplicateFrames: 0,
      encodingSpeed: 0,
      bandwidth: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      errorCount: 0,
      warningCount: 0,
      bufferHealth: "good",
      timestamp: new Date(),
    };
  }

  public startMonitoring(streamUrl?: string): void {
    if (this.isMonitoring) {
      logger.warn("Stream monitoring already active");
      return;
    }

    this.isMonitoring = true;
    this.isInStartupPhase = true;
    this.streamStartTime = new Date();
    this.currentMetrics.streamUrl = streamUrl;
    this.currentMetrics.streamStartTime = this.streamStartTime;
    this.consecutivePoorQuality = 0; // Reset consecutive poor quality counter

    logger.info("Starting stream quality monitoring with startup grace period", {
      streamUrl: streamUrl ? `${streamUrl.substring(0, 50)}...` : "unknown",
      timestamp: this.streamStartTime.toISOString(),
      gracePeriodMs: this.startupGracePeriodMs,
    });

    // Start metrics collection every 2 seconds
    this.monitorInterval = setInterval(() => {
      this.collectMetrics().catch((error) => {
        logger.error("Error collecting stream metrics", error);
        this.currentMetrics.errorCount++;
      });
    }, 2000);

    // Perform quality analysis every 10 seconds, but be less aggressive during startup
    this.qualityCheckInterval = setInterval(() => {
      this.analyzeStreamQuality().catch((error) => {
        logger.error("Error analyzing stream quality", error);
      });
    }, 10000);

    // End startup phase after grace period
    setTimeout(() => {
      if (this.isMonitoring) {
        this.isInStartupPhase = false;
        logger.info("Stream startup grace period ended, full quality monitoring active");
      }
    }, this.startupGracePeriodMs);

    this.emit("monitoring-started", {
      streamUrl,
      timestamp: this.streamStartTime,
    });
  }

  public stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;
    this.isInStartupPhase = false;
    this.isStreamEnded = false;
    this.streamEndTime = undefined as any;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined as any;
    }

    if (this.qualityCheckInterval) {
      clearInterval(this.qualityCheckInterval);
      this.qualityCheckInterval = undefined as any;
    }

    const sessionDuration = this.streamStartTime ? Date.now() - this.streamStartTime.getTime() : 0;

    logger.info("Stopped stream quality monitoring", {
      sessionDuration: this.formatDuration(sessionDuration),
      totalFrames: (this.currentMetrics.frameRate * sessionDuration) / 1000,
      averageBitrate: this.getAverageBitrate(),
      totalErrors: this.currentMetrics.errorCount,
    });

    this.emit("monitoring-stopped", {
      duration: sessionDuration,
      finalMetrics: { ...this.currentMetrics },
    });

    // Reset metrics but keep history
    this.currentMetrics = this.initializeMetrics();
    this.streamStartTime = undefined as any;
  }

  public attachFFmpegProcess(process: ChildProcess): void {
    this.ffmpegProcess = process;

    // Monitor FFmpeg stdout/stderr for statistics
    if (process.stderr) {
      process.stderr.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          this.parseFFmpegOutput(line.trim());
        }
      });
    }

    // Handle process events
    process.on("error", (error) => {
      logger.error("FFmpeg process error", error);
      this.currentMetrics.errorCount++;
      this.currentMetrics.lastError = error.message;
      this.emit("ffmpeg-error", error);
    });

    process.on("exit", (code, signal) => {
      logger.info("FFmpeg process exited", { code, signal });
      this.ffmpegProcess = undefined as any;

      // Handle stream end regardless of exit code
      this.handleStreamEnd(code, signal);

      if (code !== 0 && code !== null) {
        this.currentMetrics.errorCount++;
        this.emit("ffmpeg-exit", { code, signal });
      }
    });

    logger.debug("Attached to FFmpeg process", { pid: process.pid });
  }

  private async collectMetrics(): Promise<void> {
    const startTime = performance.now();

    try {
      // Update stream duration
      if (this.streamStartTime) {
        this.currentMetrics.streamDuration = Date.now() - this.streamStartTime.getTime();
      }

      // Collect system metrics
      await this.collectSystemMetrics();

      // Collect network metrics
      await this.collectNetworkMetrics();

      // Update buffer health
      this.updateBufferHealth();

      // Update timestamp
      this.currentMetrics.timestamp = new Date();

      // Add to history
      this.addToHistory();

      // Emit metrics update
      this.emit("metrics-updated", { ...this.currentMetrics });

      const collectionTime = performance.now() - startTime;
      if (collectionTime > 100) {
        logger.warn("Slow metrics collection", { duration: collectionTime });
      }
    } catch (error) {
      logger.error("Failed to collect stream metrics", error);
      this.currentMetrics.errorCount++;
      this.currentMetrics.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  public parseFFmpegOutput(line: string): void {
    if (!line || line.length === 0) return;

    // Parse progress line: frame= 1234 fps=30 q=25.0 size=1024kB time=00:01:23.45 bitrate=1234.5kbits/s speed=1.0x
    const progressMatch = line.match(
      /frame=\s*(\d+).*?fps=\s*([\d.]+).*?q=\s*([\d.-]+).*?size=\s*(\S+).*?time=(\S+).*?bitrate=\s*([\d.]+)\w*\/s.*?speed=\s*([\d.]+)x/
    );

    if (progressMatch) {
      const [, frame, fps, quality, size, time, bitrate, speed] = progressMatch;

      // Parse duplicate and drop info if present
      const dupMatch = line.match(/dup=(\d+)/);
      const dropMatch = line.match(/drop=(\d+)/);

      const stats: FFmpegStats = {
        frame: parseInt(frame, 10),
        fps: parseFloat(fps),
        q: parseFloat(quality),
        size,
        time,
        bitrate,
        speed,
      };

      if (dupMatch) {
        stats.dup = parseInt(dupMatch[1], 10);
      }
      if (dropMatch) {
        stats.drop = parseInt(dropMatch[1], 10);
      }

      this.updateFFmpegStats(stats);

      this.lastStatsUpdate = Date.now();
      return;
    }

    // Parse input stream info
    const streamMatch = line.match(/Stream #\d+:\d+.*?Video:.*?(\d+)x(\d+)/);
    if (streamMatch) {
      const [, width, height] = streamMatch;
      this.currentMetrics.resolution = {
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
      logger.debug("Detected stream resolution", this.currentMetrics.resolution);
      return;
    }

    // Parse stream end indicators
    if (line.includes("Exiting normally") || line.includes("received signal")) {
      this.handleStreamEnd(0, null);
      return;
    }

    // Parse errors and warnings
    if (line.includes("Error") || line.includes("error")) {
      this.currentMetrics.errorCount++;
      this.currentMetrics.lastError = line;
      logger.error("FFmpeg error detected", { error: line });
    } else if (line.includes("Warning") || line.includes("warning")) {
      this.currentMetrics.warningCount++;
      logger.warn("FFmpeg warning detected", { warning: line });
    }
  }

  private updateFFmpegStats(stats: FFmpegStats): void {
    this.currentMetrics.frameRate = stats.fps;
    this.currentMetrics.encodingSpeed = parseFloat(stats.speed);

    // Parse bitrate (remove units and convert to kbps)
    const bitrateStr = stats.bitrate.replace(/[^\d.]/g, "");
    this.currentMetrics.bitrate = parseFloat(bitrateStr) || 0;

    // Update dropped/duplicate frames
    if (stats.drop !== undefined) {
      this.currentMetrics.droppedFrames = stats.drop;
    }
    if (stats.dup !== undefined) {
      this.currentMetrics.duplicateFrames = stats.dup;
    }
  }

  private async collectSystemMetrics(): Promise<void> {
    try {
      // CPU usage
      if (this.ffmpegProcess?.pid) {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        try {
          const { stdout } = await execAsync(
            `ps -p ${this.ffmpegProcess.pid} -o %cpu,%mem --no-headers`
          );
          const [cpu, mem] = stdout.trim().split(/\s+/).map(parseFloat);
          this.currentMetrics.cpuUsage = cpu || 0;
          this.currentMetrics.memoryUsage = mem || 0;
        } catch {
          // Process might have ended
        }
      }

      // GPU usage (if available)
      try {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(
          "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits"
        );
        const gpuUsage = parseFloat(stdout.trim());
        if (!Number.isNaN(gpuUsage)) {
          this.currentMetrics.gpuUsage = gpuUsage;
        }
      } catch {
        // GPU monitoring not available
      }
    } catch (_error) {
      // System metrics collection failed
    }
  }

  private async collectNetworkMetrics(): Promise<void> {
    // This is a simplified implementation
    // In a real scenario, you'd measure actual network performance

    // Estimate bandwidth based on bitrate and overhead
    this.currentMetrics.bandwidth = Math.round(this.currentMetrics.bitrate * 1.2); // Add 20% overhead

    // Check if we're falling behind (encoding speed < 1.0)
    if (this.currentMetrics.encodingSpeed < 0.95) {
      this.currentMetrics.packetLoss = Math.max(0, (1 - this.currentMetrics.encodingSpeed) * 10);
    } else {
      this.currentMetrics.packetLoss = 0;
    }
  }

  private updateBufferHealth(): void {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastStatsUpdate;

    if (timeSinceLastUpdate > 10000) {
      // No updates for 10+ seconds
      this.currentMetrics.bufferHealth = "critical";
    } else if (this.currentMetrics.encodingSpeed < 0.8) {
      this.currentMetrics.bufferHealth = "critical";
    } else if (this.currentMetrics.encodingSpeed < 0.9 || this.currentMetrics.droppedFrames > 50) {
      this.currentMetrics.bufferHealth = "warning";
    } else {
      this.currentMetrics.bufferHealth = "good";
    }
  }

  private addToHistory(): void {
    this.metricsHistory.push({ ...this.currentMetrics });

    // Keep only last 300 entries (10 minutes at 2s intervals)
    if (this.metricsHistory.length > 300) {
      this.metricsHistory = this.metricsHistory.slice(-300);
    }
  }

  private async analyzeStreamQuality(): Promise<void> {
    // Skip quality analysis if stream has ended
    if (this.isStreamEnded) {
      logger.debug("Stream quality analysis skipped - stream has ended");
      return;
    }

    // Check for stale stream (no FFmpeg output for extended period)
    const timeSinceLastStats = Date.now() - this.lastStatsUpdate;
    if (this.lastStatsUpdate > 0 && timeSinceLastStats > this.staleStreamTimeoutMs) {
      logger.warn("Stale stream detected - no FFmpeg output received", {
        timeSinceLastStats,
        threshold: this.staleStreamTimeoutMs,
      });
      this.handleStreamEnd(null, "STALE");
      return;
    }

    const healthStatus = this.calculateStreamHealth();

    // During startup phase, be more lenient with quality assessment
    if (this.isInStartupPhase) {
      logger.debug("Stream quality analysis (startup phase)", {
        status: healthStatus.status,
        score: healthStatus.score,
        timeElapsed: this.streamStartTime ? Date.now() - this.streamStartTime.getTime() : 0,
        gracePeriodRemaining:
          this.startupGracePeriodMs -
          (this.streamStartTime ? Date.now() - this.streamStartTime.getTime() : 0),
      });

      // Only count critical issues during startup, ignore poor quality
      if (healthStatus.status === "critical") {
        this.consecutivePoorQuality++;
      } else {
        this.consecutivePoorQuality = 0;
      }

      // Only trigger alerts during startup if it's extremely critical and persistent
      if (this.consecutivePoorQuality >= 6) {
        // More lenient during startup
        logger.warn("Critical stream issues detected during startup", {
          status: healthStatus.status,
          issues: healthStatus.issues,
          recommendations: healthStatus.recommendations,
        });

        this.emit("quality-alert", {
          severity: "critical",
          status: healthStatus,
          consecutiveCount: this.consecutivePoorQuality,
          isStartupPhase: true,
        });
      }
    } else {
      // Normal operation - use regular thresholds
      if (healthStatus.status === "poor" || healthStatus.status === "critical") {
        this.consecutivePoorQuality++;
      } else {
        this.consecutivePoorQuality = 0;
      }

      logger.debug("Stream quality analysis", {
        status: healthStatus.status,
        score: healthStatus.score,
        consecutivePoor: this.consecutivePoorQuality,
      });

      // Trigger alerts for persistent issues (normal operation)
      if (this.consecutivePoorQuality >= 3) {
        logger.warn("Persistent stream quality issues detected", {
          status: healthStatus.status,
          issues: healthStatus.issues,
          recommendations: healthStatus.recommendations,
        });

        this.emit("quality-alert", {
          severity: healthStatus.status === "critical" ? "critical" : "warning",
          status: healthStatus,
          consecutiveCount: this.consecutivePoorQuality,
          isStartupPhase: false,
        });
      }
    }

    this.emit("quality-analysis", healthStatus);
  }

  private calculateStreamHealth(): StreamHealthStatus {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    const metrics = this.currentMetrics;

    // Use more lenient thresholds during startup phase
    const startupMultiplier = this.isInStartupPhase ? 0.1 : 1.0; // Much more lenient during startup
    const startupFpsThreshold = this.isInStartupPhase ? 5 : this.qualityThresholds.poor.fps;
    const startupBitrateThreshold = this.isInStartupPhase
      ? 100
      : this.qualityThresholds.poor.bitrate;

    // Frame rate analysis
    if (metrics.frameRate < startupFpsThreshold) {
      const penalty = this.isInStartupPhase ? 10 : 30; // Reduced penalty during startup
      score -= penalty * startupMultiplier;
      if (!this.isInStartupPhase) {
        issues.push("Very low frame rate");
        recommendations.push("Reduce resolution or bitrate");
      }
    } else if (metrics.frameRate < this.qualityThresholds.degraded.fps && !this.isInStartupPhase) {
      score -= 15;
      issues.push("Below target frame rate");
      recommendations.push("Check CPU/GPU usage");
    }

    // Bitrate analysis
    if (metrics.bitrate < startupBitrateThreshold) {
      const penalty = this.isInStartupPhase ? 5 : 25; // Reduced penalty during startup
      score -= penalty * startupMultiplier;
      if (!this.isInStartupPhase) {
        issues.push("Very low bitrate");
        recommendations.push("Check network connection");
      }
    } else if (
      metrics.bitrate < this.qualityThresholds.degraded.bitrate &&
      !this.isInStartupPhase
    ) {
      score -= 10;
      issues.push("Below optimal bitrate");
    }

    // Dropped frames analysis
    if (metrics.droppedFrames > this.qualityThresholds.poor.droppedFrames) {
      score -= 20;
      issues.push("High frame drops");
      recommendations.push("Reduce encoding settings or check system resources");
    } else if (metrics.droppedFrames > this.qualityThresholds.degraded.droppedFrames) {
      score -= 10;
      issues.push("Some frame drops detected");
    }

    // Encoding speed analysis (be very lenient during startup)
    const startupSpeedThreshold = this.isInStartupPhase ? 0.5 : this.qualityThresholds.poor.speed;
    if (metrics.encodingSpeed < startupSpeedThreshold) {
      const penalty = this.isInStartupPhase ? 5 : 25; // Much reduced penalty during startup
      score -= penalty * startupMultiplier;
      if (!this.isInStartupPhase) {
        issues.push("Encoding falling behind real-time");
        recommendations.push("Reduce quality settings or upgrade hardware");
      }
    } else if (
      metrics.encodingSpeed < this.qualityThresholds.degraded.speed &&
      !this.isInStartupPhase
    ) {
      score -= 10;
      issues.push("Encoding speed below optimal");
    }

    // Buffer health (only report critical issues during startup)
    if (metrics.bufferHealth === "critical") {
      const penalty = this.isInStartupPhase ? 5 : 30; // Much reduced penalty during startup
      score -= penalty * startupMultiplier;
      if (!this.isInStartupPhase) {
        issues.push("Critical buffer issues");
        recommendations.push("Restart stream or check network");
      }
    } else if (metrics.bufferHealth === "warning" && !this.isInStartupPhase) {
      score -= 15;
      issues.push("Buffer health degraded");
    }

    // System resource analysis
    if (metrics.cpuUsage > 90) {
      score -= 15;
      issues.push("High CPU usage");
      recommendations.push("Enable hardware acceleration or reduce quality");
    }

    if (metrics.gpuUsage && metrics.gpuUsage > 95) {
      score -= 10;
      issues.push("High GPU usage");
      recommendations.push("Reduce encoding settings");
    }

    // Determine status based on score
    let status: StreamHealthStatus["status"];
    if (score >= 90) {
      status = "excellent";
    } else if (score >= 75) {
      status = "good";
    } else if (score >= 60) {
      status = "degraded";
    } else if (score >= 40) {
      status = "poor";
    } else {
      status = "critical";
    }

    return {
      status,
      score: Math.max(0, score),
      issues,
      recommendations,
      timestamp: new Date(),
    };
  }

  // Public API methods

  public getCurrentMetrics(): StreamQualityMetrics {
    return { ...this.currentMetrics };
  }

  public getMetricsHistory(minutes = 10): StreamQualityMetrics[] {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.metricsHistory.filter((m) => m.timestamp.getTime() > cutoff);
  }

  public getCurrentQuality(): StreamHealthStatus {
    return this.calculateStreamHealth();
  }

  public getStreamStatistics(): {
    uptime: number;
    averageFps: number;
    averageBitrate: number;
    totalFrames: number;
    totalDrops: number;
    qualityScore: number;
  } {
    if (this.metricsHistory.length === 0) {
      return {
        uptime: 0,
        averageFps: 0,
        averageBitrate: 0,
        totalFrames: 0,
        totalDrops: 0,
        qualityScore: 0,
      };
    }

    const recentHistory = this.metricsHistory.slice(-30); // Last minute
    const avgFps = recentHistory.reduce((sum, m) => sum + m.frameRate, 0) / recentHistory.length;
    const avgBitrate = recentHistory.reduce((sum, m) => sum + m.bitrate, 0) / recentHistory.length;

    return {
      uptime: this.currentMetrics.streamDuration,
      averageFps: Math.round(avgFps * 100) / 100,
      averageBitrate: Math.round(avgBitrate),
      totalFrames: Math.round((avgFps * this.currentMetrics.streamDuration) / 1000),
      totalDrops: this.currentMetrics.droppedFrames,
      qualityScore: this.calculateStreamHealth().score,
    };
  }

  public isStreamHealthy(): boolean {
    const quality = this.calculateStreamHealth();
    return quality.status === "excellent" || quality.status === "good";
  }

  private getAverageBitrate(): number {
    if (this.metricsHistory.length === 0) return 0;
    const sum = this.metricsHistory.reduce((acc, m) => acc + m.bitrate, 0);
    return Math.round(sum / this.metricsHistory.length);
  }

  public isInStartup(): boolean {
    return this.isInStartupPhase;
  }

  public getStartupTimeRemaining(): number {
    if (!this.isInStartupPhase || !this.streamStartTime) {
      return 0;
    }
    const elapsed = Date.now() - this.streamStartTime.getTime();
    return Math.max(0, this.startupGracePeriodMs - elapsed);
  }

  private formatDuration(durationMs: number): string {
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  private handleStreamEnd(exitCode: number | null, signal: string | null): void {
    if (this.isStreamEnded) {
      return; // Already handled
    }

    this.isStreamEnded = true;
    this.streamEndTime = new Date();

    const duration = this.streamStartTime ? Date.now() - this.streamStartTime.getTime() : 0;

    logger.info("Stream ended - stopping quality monitoring", {
      exitCode,
      signal,
      duration: this.formatDuration(duration),
      finalMetrics: {
        frameRate: this.currentMetrics.frameRate,
        bitrate: this.currentMetrics.bitrate,
        encodingSpeed: this.currentMetrics.encodingSpeed,
      },
    });

    // Emit stream end event instead of quality issues
    this.emit("stream-ended", {
      exitCode,
      signal,
      duration,
      finalMetrics: this.currentMetrics,
      timestamp: this.streamEndTime,
    });

    // Stop quality monitoring
    this.stopMonitoring();
  }
}
