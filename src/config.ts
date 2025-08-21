import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface StreamConfig {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  maxBitrateKbps: number;
  hardwareAcceleration: boolean;
  videoCodec: "H264" | "H265";
}

export interface BotConfig {
  token: string;
  guildId: string;
  channelId: string;
  allowedUserIds: string[];
  streamOpts: StreamConfig;
}

const DEFAULT_CONFIG: BotConfig = {
  token: "",
  guildId: "",
  channelId: "",
  allowedUserIds: [],
  streamOpts: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 2500,
    maxBitrateKbps: 4000,
    hardwareAcceleration: false,
    videoCodec: "H264",
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
    };

    // Validate required fields
    if (!config.token) {
      throw new Error("Token is required in config");
    }

    if (!config.guildId) {
      throw new Error("Guild ID is required in config");
    }

    if (!config.channelId) {
      throw new Error("Channel ID is required in config");
    }

    if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
      throw new Error("At least one allowed user ID is required in config");
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
