import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getConfig } from "./config.js";
import { Bot } from "./bot.js";
import { HealthServer } from "./health.js";
import { initializeLogger, getLogger, LogLevel } from "./utils/logger.js";

process.on("unhandledRejection", (reason: string, p: Promise<unknown>) => {
  const logger = getLogger();
  logger.logError("Unhandled Promise Rejection", {
    reason: String(reason),
    promise: String(p),
  });
});

process.on("uncaughtException", (error: Error) => {
  const logger = getLogger();
  logger.logError("Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

const configPath = fileURLToPath(
  argv[2]
    ? new URL(argv[2], pathToFileURL(process.cwd()))
    : new URL("../config/default.jsonc", import.meta.url),
);
const config = await getConfig(configPath);

// Initialize logger with config
initializeLogger({
  level: config.logging?.level || LogLevel.INFO,
  enableConsole: config.logging?.enableConsole ?? true,
  enableFile: config.logging?.enableFile ?? true,
  logDir: config.logging?.logDir || "logs",
});

const logger = getLogger();
logger.info(`Loading config from ${configPath}`, { configPath });

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
  logger.info(`Health server started on port ${healthPort}`, {
    port: healthPort,
  });
} catch (error) {
  logger.logError("Failed to start health server", { port: healthPort, error });
  process.exit(1);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM, shutting down gracefully...", {
    signal: "SIGTERM",
  });
  await healthServer.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down gracefully...", {
    signal: "SIGINT",
  });
  await healthServer.stop();
  process.exit(0);
});
