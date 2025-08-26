import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getConfig } from "./config.js";
import { Bot } from "./bot.js";
import { HealthServer } from "./health.js";

process.on("unhandledRejection", (reason: string, p: Promise<unknown>) => {
  console.error("Unhandled Rejection at:", p, "reason:", reason);
});

const configPath = fileURLToPath(
  argv[2]
    ? new URL(argv[2], pathToFileURL(process.cwd()))
    : new URL("../config/default.jsonc", import.meta.url),
);
console.log(`Loading config from ${configPath}`);
const config = await getConfig(configPath);

const bot = new Bot({
  config,
  modulesPath: new URL("./modules", import.meta.url),
});

// Start health server
const healthPort = process.env.HEALTH_PORT
  ? Number.parseInt(process.env.HEALTH_PORT)
  : 8080;
const healthServer = new HealthServer(bot, { port: healthPort });

// Start health server immediately (it doesn't need to wait for bot to be ready)
try {
  await healthServer.start();
} catch (error) {
  console.error("Failed to start health server:", error);
  process.exit(1);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  await healthServer.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Received SIGINT, shutting down gracefully...");
  await healthServer.stop();
  process.exit(0);
});
