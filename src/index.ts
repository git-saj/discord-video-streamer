import { loadConfig } from "./config.js";
import { botLogger } from "./logger.js";
import { DiscordStreamBot } from "./discord-stream-bot.js";

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
