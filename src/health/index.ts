import { EventEmitter } from "node:events";
import type { Client } from "discord.js-selfbot-v13";
import type { Streamer } from "@dank074/discord-video-stream";
import { HealthMonitor } from "./health-monitor.js";
import { AutoRecoverySystem, type RecoveryConfig } from "./auto-recovery.js";
import { HealthServer, type HealthServerConfig } from "./health-server.js";
import { StreamMonitor } from "./stream-monitor.js";
import { botLogger as logger } from "../logger.js";

export interface HealthSystemConfig {
  enabled: boolean;
  healthServer: HealthServerConfig;
  autoRecovery: RecoveryConfig;
  monitoring: {
    healthCheckInterval: number;
    metricsInterval: number;
    enableStreamMonitoring: boolean;
  };
}

export class HealthSystem extends EventEmitter {
  private client: Client;
  private streamer: Streamer;
  private config: HealthSystemConfig;

  // Health system components
  private healthMonitor!: HealthMonitor;
  private recoverySystem!: AutoRecoverySystem;
  private healthServer!: HealthServer;
  private streamMonitor!: StreamMonitor;

  private isInitialized = false;
  private isStarted = false;

  constructor(client: Client, streamer: Streamer, config: Partial<HealthSystemConfig> = {}) {
    super();

    this.client = client;
    this.streamer = streamer;

    // Default configuration
    this.config = {
      enabled: true,
      healthServer: {
        port: parseInt(process.env.HEALTH_PORT || "8080", 10),
        host: process.env.HEALTH_HOST || "0.0.0.0",
        enableMetrics: process.env.ENABLE_METRICS !== "false",
        enableRecoveryEndpoints: process.env.ENABLE_RECOVERY_ENDPOINTS === "true",
        timeout: 10000,
      },
      autoRecovery: {
        enabled: process.env.AUTO_RECOVERY !== "false",
        maxRetriesPerHour: parseInt(process.env.MAX_RECOVERY_RETRIES || "10", 10),
        criticalErrorThreshold: parseInt(process.env.CRITICAL_ERROR_THRESHOLD || "5", 10),
        autoRestartThreshold: parseInt(process.env.AUTO_RESTART_THRESHOLD || "3", 10),
        recoveryActions: {
          reconnectDiscord: process.env.RECOVERY_RECONNECT_DISCORD !== "false",
          reconnectVoice: process.env.RECOVERY_RECONNECT_VOICE !== "false",
          restartStream: process.env.RECOVERY_RESTART_STREAM !== "false",
          clearCache: process.env.RECOVERY_CLEAR_CACHE !== "false",
          forceGarbageCollection: process.env.RECOVERY_FORCE_GC !== "false",
        },
      },
      monitoring: {
        healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "30000", 10),
        metricsInterval: parseInt(process.env.METRICS_INTERVAL || "5000", 10),
        enableStreamMonitoring: process.env.ENABLE_STREAM_MONITORING !== "false",
      },
      ...config,
    };

    this.initializeComponents();
  }

  private initializeComponents(): void {
    if (this.isInitialized) return;

    logger.info("Initializing health system components", {
      enabled: this.config.enabled,
      healthServerPort: this.config.healthServer.port,
      autoRecovery: this.config.autoRecovery.enabled,
    });

    // Initialize health monitor
    this.healthMonitor = new HealthMonitor(this.client, this.streamer, this);

    // Initialize auto-recovery system
    this.recoverySystem = new AutoRecoverySystem(
      this.client,
      this.streamer,
      this.healthMonitor,
      this.config.autoRecovery
    );

    // Initialize health server
    this.healthServer = new HealthServer(
      this.healthMonitor,
      this.recoverySystem,
      this.config.healthServer
    );

    // Initialize stream monitor
    this.streamMonitor = new StreamMonitor();

    // Setup event forwarding and cross-component communication
    this.setupEventHandlers();

    this.isInitialized = true;
    logger.info("Health system components initialized");
  }

  private setupEventHandlers(): void {
    // Forward health monitor events
    this.healthMonitor.on("metrics-updated", (metrics) => {
      this.emit("metrics-updated", metrics);
    });

    this.healthMonitor.on("health-check-completed", (result) => {
      this.emit("health-check-completed", result);
    });

    this.healthMonitor.on("discord-disconnected", () => {
      this.emit("discord-disconnected");
    });

    this.healthMonitor.on("voice-disconnected", () => {
      this.emit("voice-disconnected");
    });

    this.healthMonitor.on("discord-error", (error) => {
      this.emit("discord-error", error);
    });

    this.healthMonitor.on("critical-error", (error) => {
      this.emit("critical-error", error);
    });

    // Forward recovery system events
    this.recoverySystem.on("recovery-started", (actions) => {
      logger.info("Auto-recovery started", { actions });
      this.emit("recovery-started", actions);
    });

    this.recoverySystem.on("recovery-completed", (results) => {
      logger.info("Auto-recovery completed", {
        successful: results.filter((r) => r.success).length,
        total: results.length,
      });
      this.emit("recovery-completed", results);
    });

    this.recoverySystem.on("recovery-failed", (results) => {
      logger.error("Auto-recovery failed completely", { results });
      this.emit("recovery-failed", results);
    });

    // Forward stream monitor events
    this.streamMonitor.on("monitoring-started", (info) => {
      logger.info("Stream monitoring started", info);
      this.emit("stream-monitoring-started", info);
    });

    this.streamMonitor.on("monitoring-stopped", (info) => {
      logger.info("Stream monitoring stopped", info);
      this.emit("stream-monitoring-stopped", info);
    });

    this.streamMonitor.on("quality-alert", (alert) => {
      logger.warn("Stream quality alert", alert);
      this.emit("stream-quality-alert", alert);

      // Only trigger recovery if stream quality is critical AND not in startup phase
      if (alert.severity === "critical" && !alert.isStartupPhase) {
        logger.warn("🚨 Stream quality critical - triggering recovery", {
          status: alert.status.status,
          issues: alert.status.issues,
          consecutiveCount: alert.consecutiveCount,
        });
        this.triggerStreamRecovery();
      } else if (alert.severity === "critical" && alert.isStartupPhase) {
        logger.info("🛡️ Critical quality alert during startup grace period - recovery suppressed", {
          consecutiveCount: alert.consecutiveCount,
          startupTimeRemaining: this.streamMonitor.getStartupTimeRemaining(),
          reason: "Stream is still in 60-second startup grace period",
          issues: alert.status.issues,
        });
      }
    });

    this.streamMonitor.on("ffmpeg-error", (error) => {
      logger.error("FFmpeg error detected by stream monitor", error);
      this.emit("ffmpeg-error", error);
    });

    this.streamMonitor.on("stream-ended", (event) => {
      logger.info("Stream ended naturally - no recovery needed", {
        duration: event.duration,
        exitCode: event.exitCode,
        finalMetrics: {
          frameRate: event.finalMetrics.frameRate,
          bitrate: event.finalMetrics.bitrate,
          encodingSpeed: event.finalMetrics.encodingSpeed,
        },
      });
      this.emit("stream-ended", event);
    });

    // Handle process signals for graceful shutdown
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
  }

  public async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info("Health system disabled by configuration");
      return;
    }

    if (this.isStarted) {
      logger.warn("Health system already started");
      return;
    }

    logger.info("Starting health system");

    try {
      // Start health monitoring
      this.healthMonitor.start(
        this.config.monitoring.healthCheckInterval,
        this.config.monitoring.metricsInterval
      );

      // Start health server
      await this.healthServer.start();

      this.isStarted = true;

      logger.info("Health system started successfully", {
        healthServerPort: this.config.healthServer.port,
        monitoringEnabled: true,
        recoveryEnabled: this.config.autoRecovery.enabled,
      });

      this.emit("health-system-started");
    } catch (error) {
      logger.error("Failed to start health system", error);
      this.emit("health-system-error", error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isStarted) return;

    logger.info("Stopping health system");

    try {
      // Stop health monitoring
      this.healthMonitor.stop();

      // Stop stream monitoring
      this.streamMonitor.stopMonitoring();

      // Stop health server
      await this.healthServer.stop();

      this.isStarted = false;

      logger.info("Health system stopped");
      this.emit("health-system-stopped");
    } catch (error) {
      logger.error("Error stopping health system", error);
      this.emit("health-system-error", error);
    }
  }

  public async shutdown(signal?: string): Promise<void> {
    logger.info("Health system shutdown requested", { signal });

    this.emit("health-system-shutdown", signal);

    try {
      await this.stop();
      logger.info("Health system shutdown completed");
    } catch (error) {
      logger.error("Error during health system shutdown", error);
    }
  }

  // Stream monitoring integration
  public onStreamStarted(
    streamUrl: string,
    channelId?: string,
    controller?: AbortController
  ): void {
    logger.debug("Stream started notification received", {
      streamUrl: `${streamUrl.substring(0, 50)}...`,
    });

    // Update recovery system with current stream state
    this.recoverySystem.updateBotState(streamUrl, channelId, controller);

    // Notify health monitor about stream start for grace period
    this.healthMonitor.notifyStreamStarted();

    logger.info("🛡️ Stream startup grace periods activated", {
      healthMonitorGracePeriod: "30 seconds",
      streamQualityGracePeriod: "60 seconds",
      autoRecoveryGracePeriod: "60 seconds",
      recoveryActionsSuppressed: true,
      streamUrl: `${streamUrl.substring(0, 50)}...`,
    });

    // Start stream quality monitoring if enabled
    if (this.config.monitoring.enableStreamMonitoring) {
      this.streamMonitor.startMonitoring(streamUrl);
    }

    this.emit("stream-started", { streamUrl, channelId });
  }

  public onStreamStopped(): void {
    logger.debug("Stream stopped notification received");

    // Clear recovery system state
    this.recoverySystem.updateBotState();

    // Stop stream monitoring
    this.streamMonitor.stopMonitoring();

    this.emit("stream-stopped");
  }

  public onFFmpegProcess(process: any): void {
    // Attach stream monitor to FFmpeg process for real-time stats
    if (this.config.monitoring.enableStreamMonitoring) {
      this.streamMonitor.attachFFmpegProcess(process);
    }
  }

  public onFFmpegStderr(line: string): void {
    // Forward FFmpeg stderr to stream monitor for stats parsing
    if (this.config.monitoring.enableStreamMonitoring) {
      this.streamMonitor.parseFFmpegOutput(line);
    }
  }

  private async triggerStreamRecovery(): Promise<void> {
    logger.warn("Triggering stream recovery due to quality issues");

    try {
      await this.recoverySystem.forceRecovery(["restart-ffmpeg", "restart-stream"]);
    } catch (error) {
      logger.error("Failed to trigger stream recovery", error);
    }
  }

  // Public API for external usage

  public isHealthy(): boolean {
    return this.healthMonitor.isHealthy();
  }

  public isReady(): boolean {
    return this.healthMonitor.isReady();
  }

  public isLive(): boolean {
    return this.healthMonitor.isLive();
  }

  public async getCurrentHealthStatus(): Promise<any> {
    return this.healthMonitor.getCurrentHealthStatus();
  }

  public getMetrics() {
    return this.healthMonitor.getMetrics();
  }

  public getStreamMetrics() {
    return this.streamMonitor.getCurrentMetrics();
  }

  public getStreamQuality() {
    return this.streamMonitor.getCurrentQuality();
  }

  public getRecoveryStats() {
    return this.recoverySystem.getRecoveryStats();
  }

  public async forceRecovery(actions: string[]) {
    return this.recoverySystem.forceRecovery(actions);
  }

  public updateConfig(newConfig: Partial<HealthSystemConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Update component configs
    if (newConfig.autoRecovery) {
      this.recoverySystem.updateConfig(newConfig.autoRecovery);
    }

    logger.info("Health system config updated");
  }

  // Utility methods for status reporting

  public getSystemStatus(): {
    healthy: boolean;
    ready: boolean;
    live: boolean;
    uptime: number;
    components: {
      discord: boolean;
      voice: boolean;
      streaming: boolean;
      recovery: boolean;
    };
    lastCheck: Date;
  } {
    const metrics = this.healthMonitor.getMetrics();

    return {
      healthy: this.isHealthy(),
      ready: this.isReady(),
      live: this.isLive(),
      uptime: metrics.uptime,
      components: {
        discord: metrics.discordConnected,
        voice: metrics.voiceConnected,
        streaming: metrics.isStreaming,
        recovery: !this.recoverySystem.isCurrentlyRecovering(),
      },
      lastCheck: metrics.timestamp,
    };
  }

  public getDetailedStatus(): {
    system: {
      healthy: boolean;
      ready: boolean;
      live: boolean;
      uptime: number;
      components: {
        discord: boolean;
        voice: boolean;
        streaming: boolean;
        recovery: boolean;
      };
      lastCheck: Date;
    };
    health: any;
    metrics: any;
    stream: any;
    recovery: any;
  } {
    return {
      system: this.getSystemStatus(),
      health: this.healthMonitor.getCurrentHealthStatus(),
      metrics: this.getMetrics(),
      stream: {
        metrics: this.getStreamMetrics(),
        quality: this.getStreamQuality(),
        statistics: this.streamMonitor.getStreamStatistics(),
      },
      recovery: this.getRecoveryStats(),
    };
  }

  // Static factory method for easy setup
  static async create(
    client: Client,
    streamer: Streamer,
    config?: Partial<HealthSystemConfig>
  ): Promise<HealthSystem> {
    const healthSystem = new HealthSystem(client, streamer, config);

    // Auto-start if enabled
    if (healthSystem.config.enabled) {
      await healthSystem.start();
    }

    return healthSystem;
  }
}

// Re-export all health system components for direct usage if needed
export { HealthMonitor } from "./health-monitor.js";
export { AutoRecoverySystem, type RecoveryConfig } from "./auto-recovery.js";
export { HealthServer, type HealthServerConfig } from "./health-server.js";
export { StreamMonitor } from "./stream-monitor.js";

// Export types
export type { HealthMetrics, HealthCheckResult } from "./health-monitor.js";
export type { RecoveryAction, RecoveryAttempt } from "./auto-recovery.js";
export type {
  StreamQualityMetrics,
  StreamHealthStatus,
} from "./stream-monitor.js";
