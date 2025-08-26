import winston from "winston";
import type { Message } from "discord.js-selfbot-v13";

export enum LogLevel {
  ERROR = "error",
  WARN = "warn",
  INFO = "info",
  DEBUG = "debug",
}

export interface LogContext {
  module?: string;
  command?: string;
  userId?: string;
  guildId?: string;
  channelId?: string;
  messageId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  level: LogLevel;
  enableConsole?: boolean;
  enableFile?: boolean;
  logDir?: string;
}

class Logger {
  private winston: winston.Logger;

  constructor(config: LoggerConfig) {
    const transports: winston.transport[] = [];

    // Console transport
    if (config.enableConsole !== false) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const metaStr =
                Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
              return `${timestamp} [${level}]: ${message}${metaStr}`;
            }),
          ),
        }),
      );
    }

    // File transport
    if (config.enableFile) {
      const logDir = config.logDir || "logs";
      transports.push(
        new winston.transports.File({
          filename: `${logDir}/error.log`,
          level: "error",
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        }),
        new winston.transports.File({
          filename: `${logDir}/combined.log`,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        }),
      );
    }

    this.winston = winston.createLogger({
      level: config.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      transports,
      defaultMeta: {
        service: "discord-video-streamer",
      },
    });
  }

  private log(level: LogLevel, message: string, context?: LogContext) {
    this.winston.log(level, message, context);
  }

  error(message: string, context?: LogContext) {
    this.log(LogLevel.ERROR, message, context);
  }

  warn(message: string, context?: LogContext) {
    this.log(LogLevel.WARN, message, context);
  }

  info(message: string, context?: LogContext) {
    this.log(LogLevel.INFO, message, context);
  }

  debug(message: string, context?: LogContext) {
    this.log(LogLevel.DEBUG, message, context);
  }

  // Helper method to create context from Discord message
  createMessageContext(
    message: Message,
    additionalContext?: LogContext,
  ): LogContext {
    const correlationId = `${message.id}-${Date.now()}`;
    return {
      correlationId,
      userId: message.author.id,
      guildId: message.guildId || undefined,
      channelId: message.channelId,
      messageId: message.id,
      ...additionalContext,
    };
  }

  // Helper method to log command execution
  logCommand(
    message: Message,
    command: string,
    args: unknown[],
    opts: unknown,
    module?: string,
  ) {
    const context = this.createMessageContext(message, {
      module,
      command,
      args: JSON.stringify(args),
      opts: JSON.stringify(opts),
    });
    this.info(`Command executed: ${command}`, context);
  }

  // Helper method to log errors with full context
  logError(error: Error | string, context?: LogContext) {
    const errorMessage = error instanceof Error ? error.message : error;
    const errorContext = {
      ...context,
      stack: error instanceof Error ? error.stack : undefined,
    };
    this.error(errorMessage, errorContext);
  }

  // Helper method to log streaming events
  logStream(
    event: string,
    streamInfo: { url?: string; quality?: string; duration?: number },
    context?: LogContext,
  ) {
    this.info(`Stream event: ${event}`, {
      ...context,
      streamUrl: streamInfo.url,
      streamQuality: streamInfo.quality,
      streamDuration: streamInfo.duration,
    });
  }
}

// Global logger instance
let globalLogger: Logger;

export function initializeLogger(config: LoggerConfig): void {
  globalLogger = new Logger(config);
}

export function getLogger(): Logger {
  if (!globalLogger) {
    // Fallback logger if not initialized
    globalLogger = new Logger({
      level: LogLevel.INFO,
      enableConsole: true,
      enableFile: false,
    });
  }
  return globalLogger;
}

export { Logger };
