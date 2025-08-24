import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { HealthSystemConfig } from "./health/index.js";

export interface StreamConfig {
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  maxBitrateKbps?: number;
  hardwareAcceleration: boolean;
  videoCodec: "H264" | "H265";
  adaptiveSettings?: boolean;
}

export interface BotConfig {
  token: string;
  streamOpts: StreamConfig;
  allowWebhooks: boolean;
  commandPrefix: string;
  health?: HealthSystemConfig;
}

const DEFAULT_CONFIG: BotConfig = {
  token: "",
  streamOpts: {
    hardwareAcceleration: false,
    videoCodec: "H264",
    adaptiveSettings: true,
  },
  allowWebhooks: false,
  commandPrefix: "!",
  health: {
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
  },
};

export async function loadConfig(configPath: string = "./config.json"): Promise<BotConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  try {
    const configData = await readFile(configPath, "utf-8");
    const parsedConfig = JSON.parse(configData) as Partial<BotConfig>;

    // Merge with defaults and validate
    const config: BotConfig = {
      ...DEFAULT_CONFIG,
      ...parsedConfig,
      streamOpts: {
        ...DEFAULT_CONFIG.streamOpts,
        ...parsedConfig.streamOpts,
      },
      health: {
        ...DEFAULT_CONFIG.health!,
        ...parsedConfig.health,
        healthServer: {
          ...DEFAULT_CONFIG.health!.healthServer,
          ...parsedConfig.health?.healthServer,
        },
        autoRecovery: {
          ...DEFAULT_CONFIG.health!.autoRecovery,
          ...parsedConfig.health?.autoRecovery,
          recoveryActions: {
            ...DEFAULT_CONFIG.health!.autoRecovery.recoveryActions,
            ...parsedConfig.health?.autoRecovery?.recoveryActions,
          },
        },
        monitoring: {
          ...DEFAULT_CONFIG.health!.monitoring,
          ...parsedConfig.health?.monitoring,
        },
      },
    };

    // Validate required fields
    if (!config.token) {
      throw new Error("Token is required in config");
    }

    return config;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${error.message}`);
    }
    throw error;
  }
}

export function validateStreamUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return (
      urlObj.protocol === "http:" || urlObj.protocol === "https:" || urlObj.protocol === "rtmp:"
    );
  } catch {
    return false;
  }
}
