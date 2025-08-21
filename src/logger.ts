import winston from "winston";

// Define log levels and colors
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const logColors = {
  error: "red",
  warn: "yellow",
  info: "cyan",
  debug: "gray",
};

// Add colors to winston
winston.addColors(logColors);

// Custom format for console output with emojis
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    const emoji = getEmojiForLevel(level);
    const serviceName = service ? `[${service}] ` : "";
    const metaString = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${emoji} ${level}: ${serviceName}${message}${metaString}`;
  })
);

// Format for file output (no colors, more structured)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

function getEmojiForLevel(level: string): string {
  // Winston already handles colorization properly, just use the level directly
  switch (level) {
    case "error":
      return "❌";
    case "warn":
      return "⚠️";
    case "info":
      return "ℹ️";
    case "debug":
      return "🔍";
    default:
      return "ℹ️";
  }
}

// Create the main logger
const logger = winston.createLogger({
  levels: logLevels,
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true })
  ),
  transports: [
    // Console transport with colorized output
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // File transport for errors
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      format: fileFormat,
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: "logs/combined.log",
      format: fileFormat,
    }),
  ],
  // Handle uncaught exceptions
  exceptionHandlers: [new winston.transports.File({ filename: "logs/exceptions.log" })],
  // Handle unhandled promise rejections
  rejectionHandlers: [new winston.transports.File({ filename: "logs/rejections.log" })],
});

// Create specialized loggers for different components
export const botLogger = logger.child({ service: "BOT" });
export const streamLogger = logger.child({ service: "STREAM" });
export const ffmpegLogger = logger.child({ service: "FFMPEG" });
export const discordLogger = logger.child({ service: "DISCORD" });

// FFmpeg output parser to extract useful information
export function parseFFmpegOutput(line: string): {
  level: string;
  message: string;
  metadata?: any;
} {
  const trimmedLine = line.trim();

  // Skip empty lines
  if (!trimmedLine) {
    return { level: "debug", message: "" };
  }

  // Error patterns
  if (
    trimmedLine.includes("Error") ||
    trimmedLine.includes("failed") ||
    trimmedLine.includes("Cannot")
  ) {
    return { level: "error", message: trimmedLine };
  }

  // Warning patterns
  if (
    trimmedLine.includes("deprecated") ||
    trimmedLine.includes("Could not find") ||
    trimmedLine.includes("Consider increasing")
  ) {
    return { level: "warn", message: trimmedLine };
  }

  // Stream info patterns
  if (
    trimmedLine.includes("Input #") ||
    trimmedLine.includes("Output #") ||
    trimmedLine.includes("Stream #")
  ) {
    return { level: "info", message: trimmedLine };
  }

  // Progress updates (frame= fps= q= size= time= bitrate= speed=)
  if (trimmedLine.includes("frame=") && trimmedLine.includes("fps=")) {
    const progressMatch = trimmedLine.match(
      /frame=\s*(\d+).*fps=\s*([\d.]+).*time=(\S+).*bitrate=\s*([\d.]+\w+\/s).*speed=\s*([\d.]+x)/
    );
    if (progressMatch) {
      const [, frame, fps, time, bitrate, speed] = progressMatch;
      return {
        level: "debug",
        message: "Encoding progress",
        metadata: {
          frame: Number(frame),
          fps: Number(fps),
          time,
          bitrate,
          speed,
        },
      };
    }
    return { level: "debug", message: trimmedLine };
  }

  // Configuration and codec info
  if (
    trimmedLine.includes("using") ||
    trimmedLine.includes("profile") ||
    trimmedLine.includes("configuration:")
  ) {
    return { level: "debug", message: trimmedLine };
  }

  // Default to debug level for other FFmpeg output
  return { level: "debug", message: trimmedLine };
}

// Helper function to log FFmpeg output with proper parsing
export function logFFmpegOutput(line: string): void {
  const { level, message, metadata } = parseFFmpegOutput(line);

  if (!message) return; // Skip empty messages

  switch (level) {
    case "error":
      ffmpegLogger.error(message, metadata);
      break;
    case "warn":
      ffmpegLogger.warn(message, metadata);
      break;
    case "info":
      ffmpegLogger.info(message, metadata);
      break;
    default:
      ffmpegLogger.debug(message, metadata);
      break;
  }
}

// Stream status logging helper
export function logStreamStatus(
  status: "starting" | "running" | "stopped" | "error",
  details?: any
): void {
  const emoji = {
    starting: "🚀",
    running: "📺",
    stopped: "🛑",
    error: "💥",
  }[status];

  const message = `Stream ${status}`;

  switch (status) {
    case "error":
      streamLogger.error(`${emoji} ${message}`, details);
      break;
    case "starting":
    case "running":
      streamLogger.info(`${emoji} ${message}`, details);
      break;
    case "stopped":
      streamLogger.warn(`${emoji} ${message}`, details);
      break;
  }
}

// Export the main logger as default
export default logger;

// Export individual methods for convenience
export const { error, warn, info, debug } = logger;
