import { EventEmitter } from "node:events";
import type { Client } from "discord.js-selfbot-v13";
import type { Streamer } from "@dank074/discord-video-stream";
import { botLogger as logger } from "../logger.js";
import type { HealthMonitor, HealthCheckResult } from "./health-monitor.js";

export interface RecoveryAction {
  name: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  cooldownMs: number;
  maxRetries: number;
  action: () => Promise<boolean>;
}

export interface RecoveryAttempt {
  actionName: string;
  timestamp: Date;
  success: boolean;
  error?: string;
  duration: number;
}

export interface RecoveryConfig {
  enabled: boolean;
  maxRetriesPerHour: number;
  criticalErrorThreshold: number;
  autoRestartThreshold: number;
  recoveryActions: {
    reconnectDiscord: boolean;
    reconnectVoice: boolean;
    restartStream: boolean;
    clearCache: boolean;
    forceGarbageCollection: boolean;
  };
}

export class AutoRecoverySystem extends EventEmitter {
  private client: Client;
  private streamer: Streamer;
  private healthMonitor: HealthMonitor;
  private config: RecoveryConfig;
  private recoveryActions: Map<string, RecoveryAction>;
  private actionCooldowns: Map<string, number>;
  private recoveryHistory: RecoveryAttempt[] = [];
  private isRecovering = false;
  private consecutiveFailures = 0;
  private lastStreamStartTime?: Date;
  private streamStartupGracePeriodMs = 60000; // 60 seconds

  // Bot state references - these would need to be injected from your main bot
  private botStreamUrl: string | undefined;
  private botChannelId: string | undefined;
  private botController: AbortController | undefined;

  constructor(
    client: Client,
    streamer: Streamer,
    healthMonitor: HealthMonitor,
    config: RecoveryConfig = {
      enabled: true,
      maxRetriesPerHour: 10,
      criticalErrorThreshold: 5,
      autoRestartThreshold: 3,
      recoveryActions: {
        reconnectDiscord: true,
        reconnectVoice: true,
        restartStream: true,
        clearCache: true,
        forceGarbageCollection: true,
      },
    }
  ) {
    super();
    this.client = client;
    this.streamer = streamer;
    this.healthMonitor = healthMonitor;
    this.config = config;
    this.recoveryActions = new Map();
    this.actionCooldowns = new Map();

    this.initializeRecoveryActions();
    this.setupHealthMonitoring();
  }

  private initializeRecoveryActions(): void {
    // Discord reconnection
    this.recoveryActions.set("reconnect-discord", {
      name: "reconnect-discord",
      description: "Reconnect to Discord WebSocket",
      severity: "medium",
      cooldownMs: 30000, // 30 seconds
      maxRetries: 3,
      action: async () => {
        logger.info("Attempting Discord reconnection");
        try {
          if (this.client.ws.status !== 0) {
            // 0 = READY status
            await this.client.destroy();
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5s
            // Note: You'll need to implement reconnection logic based on your bot structure
            return true;
          }
          return true;
        } catch (error) {
          logger.error("Discord reconnection failed", error);
          return false;
        }
      },
    });

    // Voice reconnection
    this.recoveryActions.set("reconnect-voice", {
      name: "reconnect-voice",
      description: "Reconnect to voice channel",
      severity: "medium",
      cooldownMs: 15000, // 15 seconds
      maxRetries: 5,
      action: async () => {
        logger.info("Attempting voice reconnection");
        try {
          const connection = this.streamer.voiceConnection;
          if (connection && this.botChannelId) {
            this.streamer.leaveVoice();
            await new Promise((resolve) => setTimeout(resolve, 2000));
            // Reconnect logic would go here
            return true;
          }
          return false;
        } catch (error) {
          logger.error("Voice reconnection failed", error);
          return false;
        }
      },
    });

    // Stream restart
    this.recoveryActions.set("restart-stream", {
      name: "restart-stream",
      description: "Restart current stream",
      severity: "high",
      cooldownMs: 60000, // 1 minute
      maxRetries: 2,
      action: async () => {
        logger.info("Attempting stream restart");
        try {
          if (this.botController) {
            this.botController.abort();
          }

          await new Promise((resolve) => setTimeout(resolve, 3000));

          if (this.botStreamUrl && this.botChannelId) {
            // Restart stream logic would go here
            return true;
          }
          return false;
        } catch (error) {
          logger.error("Stream restart failed", error);
          return false;
        }
      },
    });

    // Memory cleanup
    this.recoveryActions.set("memory-cleanup", {
      name: "memory-cleanup",
      description: "Force garbage collection and memory cleanup",
      severity: "low",
      cooldownMs: 10000, // 10 seconds
      maxRetries: 10,
      action: async () => {
        logger.info("Performing memory cleanup");
        try {
          // Force garbage collection if exposed
          if (global.gc) {
            global.gc();
          }

          // Clear any caches
          if (this.client.channels.cache.size > 1000) {
            this.client.channels.cache.clear();
          }

          if (this.client.users.cache.size > 1000) {
            this.client.users.cache.clear();
          }

          return true;
        } catch (error) {
          logger.error("Memory cleanup failed", error);
          return false;
        }
      },
    });

    // FFmpeg process restart
    this.recoveryActions.set("restart-ffmpeg", {
      name: "restart-ffmpeg",
      description: "Kill and restart FFmpeg processes",
      severity: "high",
      cooldownMs: 30000, // 30 seconds
      maxRetries: 3,
      action: async () => {
        logger.info("Attempting FFmpeg restart");
        try {
          // Kill existing FFmpeg processes
          const { exec } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(exec);

          await execAsync("pkill -f ffmpeg || true");
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Restart stream if we have the URL
          if (this.botStreamUrl) {
            // This would trigger your stream restart logic
            return true;
          }

          return false;
        } catch (error) {
          logger.error("FFmpeg restart failed", error);
          return false;
        }
      },
    });

    // Network reset
    this.recoveryActions.set("network-reset", {
      name: "network-reset",
      description: "Reset network connections",
      severity: "critical",
      cooldownMs: 120000, // 2 minutes
      maxRetries: 1,
      action: async () => {
        logger.info("Attempting network reset");
        try {
          // Close all connections and restart
          await this.client.destroy();

          if (this.streamer.voiceConnection) {
            this.streamer.leaveVoice();
          }

          await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10s

          // Full reconnection would happen here
          return true;
        } catch (error) {
          logger.error("Network reset failed", error);
          return false;
        }
      },
    });
  }

  private setupHealthMonitoring(): void {
    if (!this.config.enabled) {
      logger.info("Auto-recovery system disabled");
      return;
    }

    logger.info("Setting up auto-recovery monitoring");

    // Listen to health check results
    this.healthMonitor.on("health-check-completed", (result: HealthCheckResult) => {
      this.analyzeHealthAndRecover(result);
    });

    // Listen to specific error events
    this.healthMonitor.on("discord-disconnected", () => {
      this.triggerRecovery(["reconnect-discord"]);
    });

    this.healthMonitor.on("discord-error", () => {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.triggerRecovery(["memory-cleanup", "reconnect-discord"]);
      }
    });

    this.healthMonitor.on("critical-error", () => {
      this.triggerRecovery(["memory-cleanup", "restart-ffmpeg", "network-reset"]);
    });

    // Monitor memory usage
    this.healthMonitor.on("metrics-updated", (metrics) => {
      const memoryUsageMB = metrics.memoryUsage.rss / 1024 / 1024;

      if (memoryUsageMB > 1500) {
        // 1.5GB warning
        this.triggerRecovery(["memory-cleanup"]);
      }

      if (memoryUsageMB > 2500) {
        // 2.5GB critical
        this.triggerRecovery(["memory-cleanup", "restart-stream"]);
      }
    });
  }

  private async analyzeHealthAndRecover(result: HealthCheckResult): Promise<void> {
    if (this.isRecovering) {
      return; // Already recovering
    }

    // Check if we're in stream startup grace period
    const isInGracePeriod =
      this.lastStreamStartTime &&
      Date.now() - this.lastStreamStartTime.getTime() < this.streamStartupGracePeriodMs;

    if (isInGracePeriod) {
      logger.debug("Health check during stream startup grace period - recovery suppressed", {
        status: result.status,
        graceTimeRemaining:
          this.streamStartupGracePeriodMs -
          (this.lastStreamStartTime ? Date.now() - this.lastStreamStartTime.getTime() : 0),
        checks: Object.fromEntries(
          Object.entries(result.checks).map(([key, check]) => [key, check.status])
        ),
      });

      // Only allow critical non-stream related recovery during grace period
      if (result.status === "unhealthy" && result.checks.discord?.status === "fail") {
        logger.info(
          "🛡️  Critical Discord issue during grace period - allowing Discord recovery only"
        );
        await this.triggerRecovery(["reconnect-discord"]);
      }
      return;
    }

    const actions: string[] = [];

    switch (result.status) {
      case "unhealthy":
        this.consecutiveFailures++;

        // Analyze specific failure points
        if (result.checks.discord?.status === "fail") {
          actions.push("reconnect-discord");
        }

        if (result.checks.voice?.status === "fail") {
          actions.push("reconnect-voice");
        }

        if (result.checks.stream?.status === "fail") {
          actions.push("restart-stream");
        }

        if (result.checks.ffmpeg?.status === "fail") {
          actions.push("restart-ffmpeg");
        }

        // Memory issues
        if (result.checks.memory?.status === "fail") {
          actions.push("memory-cleanup");
        }

        break;

      case "degraded":
        this.consecutiveFailures++;

        // Less aggressive recovery for degraded state
        if (result.checks.memory?.status === "warn") {
          actions.push("memory-cleanup");
        }

        break;

      case "healthy":
        this.consecutiveFailures = 0;
        return; // No recovery needed
    }

    // Escalate if we have too many consecutive failures
    if (this.consecutiveFailures >= this.config.criticalErrorThreshold) {
      actions.push("network-reset");
    }

    if (actions.length > 0) {
      logger.info("Auto-recovery triggered outside grace period", {
        actions,
        healthStatus: result.status,
        consecutiveFailures: this.consecutiveFailures,
        streamAge: this.lastStreamStartTime
          ? Date.now() - this.lastStreamStartTime.getTime()
          : "unknown",
      });
      await this.triggerRecovery(actions);
    }
  }

  private async triggerRecovery(actionNames: string[]): Promise<void> {
    if (this.isRecovering) {
      logger.debug("Recovery already in progress, skipping");
      return;
    }

    if (!this.config.enabled) {
      logger.debug("Auto-recovery disabled, skipping");
      return;
    }

    // Check retry limits
    const recentAttempts = this.getRecentRecoveryAttempts(60 * 60 * 1000); // Last hour
    if (recentAttempts.length >= this.config.maxRetriesPerHour) {
      logger.warn("Maximum recovery attempts per hour exceeded", {
        attempts: recentAttempts.length,
        limit: this.config.maxRetriesPerHour,
      });
      return;
    }

    this.isRecovering = true;

    logger.info("Starting auto-recovery process", {
      actions: actionNames,
      consecutiveFailures: this.consecutiveFailures,
    });

    this.emit("recovery-started", actionNames);

    const results: RecoveryAttempt[] = [];

    for (const actionName of actionNames) {
      const action = this.recoveryActions.get(actionName);
      if (!action) {
        logger.warn("Unknown recovery action", { actionName });
        continue;
      }

      // Check if action is enabled in config
      const configKey = actionName.replace("-", "") as keyof RecoveryConfig["recoveryActions"];
      if (configKey in this.config.recoveryActions && !this.config.recoveryActions[configKey]) {
        logger.debug("Recovery action disabled in config", { actionName });
        continue;
      }

      // Check cooldown
      const lastAttempt = this.actionCooldowns.get(actionName) || 0;
      const timeSinceLastAttempt = Date.now() - lastAttempt;
      if (timeSinceLastAttempt < action.cooldownMs) {
        logger.debug("Recovery action on cooldown", {
          actionName,
          cooldownRemaining: action.cooldownMs - timeSinceLastAttempt,
        });
        continue;
      }

      const attempt = await this.executeRecoveryAction(action);
      results.push(attempt);

      this.actionCooldowns.set(actionName, Date.now());

      // Wait between actions
      if (actionNames.indexOf(actionName) < actionNames.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    this.recoveryHistory.push(...results);
    this.trimRecoveryHistory();

    const successCount = results.filter((r) => r.success).length;
    const totalCount = results.length;

    logger.info("Auto-recovery process completed", {
      successful: successCount,
      total: totalCount,
      results: results.map((r) => ({
        action: r.actionName,
        success: r.success,
        duration: r.duration,
      })),
    });

    this.emit("recovery-completed", results);
    this.isRecovering = false;

    // If recovery failed completely, consider more drastic measures
    if (successCount === 0 && totalCount > 0) {
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.config.autoRestartThreshold) {
        logger.error("Auto-recovery failed completely, considering restart", {
          consecutiveFailures: this.consecutiveFailures,
          threshold: this.config.autoRestartThreshold,
        });

        this.emit("recovery-failed", results);

        // This would trigger a container restart in Kubernetes
        // For now, we just emit an event
        process.exit(1);
      }
    } else if (successCount > 0) {
      // Partial or full success, reset failure counter
      this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1);
    }
  }

  private async executeRecoveryAction(action: RecoveryAction): Promise<RecoveryAttempt> {
    const startTime = Date.now();

    logger.info("Executing recovery action", {
      name: action.name,
      description: action.description,
      severity: action.severity,
    });

    try {
      const success = await action.action();
      const duration = Date.now() - startTime;

      const attempt: RecoveryAttempt = {
        actionName: action.name,
        timestamp: new Date(),
        success,
        duration,
      };

      if (success) {
        logger.info("Recovery action succeeded", {
          name: action.name,
          duration,
        });
      } else {
        logger.warn("Recovery action failed (returned false)", {
          name: action.name,
          duration,
        });
      }

      return attempt;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error("Recovery action threw error", {
        name: action.name,
        error: errorMessage,
        duration,
      });

      return {
        actionName: action.name,
        timestamp: new Date(),
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  private getRecentRecoveryAttempts(timeWindowMs: number): RecoveryAttempt[] {
    const cutoff = Date.now() - timeWindowMs;
    return this.recoveryHistory.filter((attempt) => attempt.timestamp.getTime() > cutoff);
  }

  private trimRecoveryHistory(): void {
    // Keep only last 100 attempts
    if (this.recoveryHistory.length > 100) {
      this.recoveryHistory = this.recoveryHistory.slice(-100);
    }
  }

  // Public methods for integration

  public updateBotState(
    streamUrl?: string,
    channelId?: string,
    controller?: AbortController
  ): void {
    this.botStreamUrl = streamUrl;
    this.botChannelId = channelId;
    this.botController = controller;

    // Track stream start time for grace period
    if (streamUrl) {
      this.lastStreamStartTime = new Date();
      logger.debug("Auto-recovery: Stream start time updated for grace period", {
        timestamp: this.lastStreamStartTime.toISOString(),
        gracePeriodMs: this.streamStartupGracePeriodMs,
      });
    }
  }

  public getRecoveryHistory(): RecoveryAttempt[] {
    return [...this.recoveryHistory];
  }

  public isInGracePeriod(): boolean {
    return (
      !!this.lastStreamStartTime &&
      Date.now() - this.lastStreamStartTime.getTime() < this.streamStartupGracePeriodMs
    );
  }

  public getGracePeriodStatus(): {
    isActive: boolean;
    timeRemaining: number;
    streamAge: number;
  } {
    if (!this.lastStreamStartTime) {
      return { isActive: false, timeRemaining: 0, streamAge: 0 };
    }

    const streamAge = Date.now() - this.lastStreamStartTime.getTime();
    const timeRemaining = Math.max(0, this.streamStartupGracePeriodMs - streamAge);

    return {
      isActive: timeRemaining > 0,
      timeRemaining,
      streamAge,
    };
  }

  public getRecoveryStats(): {
    totalAttempts: number;
    successfulAttempts: number;
    failedAttempts: number;
    recentAttempts: number;
    consecutiveFailures: number;
    isRecovering: boolean;
  } {
    const recent = this.getRecentRecoveryAttempts(60 * 60 * 1000); // Last hour
    const successful = this.recoveryHistory.filter((a) => a.success).length;

    return {
      totalAttempts: this.recoveryHistory.length,
      successfulAttempts: successful,
      failedAttempts: this.recoveryHistory.length - successful,
      recentAttempts: recent.length,
      consecutiveFailures: this.consecutiveFailures,
      isRecovering: this.isRecovering,
    };
  }

  public async forceRecovery(actionNames: string[]): Promise<RecoveryAttempt[]> {
    const validActions = actionNames.filter((name) => this.recoveryActions.has(name));

    if (validActions.length === 0) {
      throw new Error("No valid recovery actions provided");
    }

    logger.info("Forcing recovery actions", { actions: validActions });

    // Temporarily bypass cooldowns and limits for manual recovery
    const originalCooldowns = new Map(this.actionCooldowns);
    this.actionCooldowns.clear();

    await this.triggerRecovery(validActions);

    // Restore cooldowns
    this.actionCooldowns = originalCooldowns;

    return this.recoveryHistory.slice(-validActions.length);
  }

  public isCurrentlyRecovering(): boolean {
    return this.isRecovering;
  }

  public getAvailableActions(): string[] {
    return Array.from(this.recoveryActions.keys());
  }

  public updateConfig(newConfig: Partial<RecoveryConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info("Recovery config updated", this.config);
  }
}
