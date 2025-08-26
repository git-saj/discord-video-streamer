import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

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
  healthProbe?: {
    enabled: boolean;
    port: number;
    host: string;
    timeout: number;
  };
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
  healthProbe: {
    enabled: process.env.HEALTH_PROBE_ENABLED !== "false",
    port: parseInt(process.env.HEALTH_PORT || "8080", 10),
    host: process.env.HEALTH_HOST || "0.0.0.0",
    timeout: parseInt(process.env.HEALTH_TIMEOUT || "10000", 10),
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
      healthProbe: {
        ...DEFAULT_CONFIG.healthProbe!,
        ...parsedConfig.healthProbe,
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
