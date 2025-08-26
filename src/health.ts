import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Bot } from "./bot.js";

export interface HealthServerConfig {
  port: number;
  host?: string;
}

export class HealthServer {
  private server: Server;
  private bot: Bot;
  private config: HealthServerConfig;

  constructor(bot: Bot, config: HealthServerConfig = { port: 8080 }) {
    this.bot = bot;
    this.config = { host: "0.0.0.0", ...config };
    this.server = createServer(this.handleRequest.bind(this));
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url;
    const method = req.method;

    // Set common headers
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    try {
      if (method !== "GET") {
        this.sendResponse(res, 405, { error: "Method not allowed" });
        return;
      }

      switch (url) {
        case "/health":
        case "/healthz":
          this.handleLiveness(res);
          break;
        case "/ready":
        case "/readiness":
          this.handleReadiness(res);
          break;
        case "/startup":
          this.handleStartup(res);
          break;
        default:
          this.sendResponse(res, 404, { error: "Not found" });
      }
    } catch (error) {
      console.error("Health check error:", error);
      this.sendResponse(res, 500, { error: "Internal server error" });
    }
  }

  private handleLiveness(res: ServerResponse): void {
    // Liveness probe: checks if the application is running
    // This should only fail if the process is completely broken
    const streamingState = (
      this.bot as typeof this.bot & {
        streamingState?: {
          isStreaming: boolean;
          queueLength: number;
          currentStream: string | null;
        };
      }
    ).streamingState;

    const status = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
      memory: process.memoryUsage(),
      streaming: streamingState
        ? {
            isStreaming: streamingState.isStreaming,
            queueLength: streamingState.queueLength,
            currentStream: streamingState.currentStream,
          }
        : null,
    };

    this.sendResponse(res, 200, status);
  }

  private handleReadiness(res: ServerResponse): void {
    // Readiness probe: checks if the application is ready to serve traffic
    // This should fail if Discord client is not ready or other critical services are down
    const isReady =
      this.bot.initialized &&
      this.bot.client.isReady() &&
      this.bot.client.user !== null;

    // Get streaming state if available
    const streamingState = (
      this.bot as typeof this.bot & {
        streamingState?: {
          isStreaming: boolean;
          isProcessing: boolean;
          queueLength: number;
          currentStream: string | null;
          voiceConnection: {
            guildId: string | null;
            channelId: string;
            ready: boolean;
          } | null;
        };
      }
    ).streamingState;

    if (isReady) {
      const status = {
        status: "ready",
        timestamp: new Date().toISOString(),
        discord: {
          ready: true,
          user: this.bot.client.user?.tag || null,
          guilds: this.bot.client.guilds.cache.size,
        },
        modules: Array.from(this.bot.allCommandsByModule.keys()),
        streaming: streamingState
          ? {
              isActive: streamingState.isStreaming,
              isProcessing: streamingState.isProcessing,
              queueLength: streamingState.queueLength,
              currentStream: streamingState.currentStream,
              voiceConnection: streamingState.voiceConnection,
            }
          : null,
      };
      this.sendResponse(res, 200, status);
    } else {
      const status = {
        status: "not ready",
        timestamp: new Date().toISOString(),
        discord: {
          ready: false,
          initialized: this.bot.initialized,
          clientReady: this.bot.client.isReady(),
          hasUser: this.bot.client.user !== null,
        },
        streaming: streamingState
          ? {
              isActive: streamingState.isStreaming,
              isProcessing: streamingState.isProcessing,
              queueLength: streamingState.queueLength,
              currentStream: streamingState.currentStream,
              voiceConnection: streamingState.voiceConnection,
            }
          : null,
      };
      this.sendResponse(res, 503, status);
    }
  }

  private handleStartup(res: ServerResponse): void {
    // Startup probe: checks if the application has started successfully
    // Similar to readiness but may have different criteria
    const hasStarted = this.bot.initialized;
    const streamingState = (
      this.bot as typeof this.bot & {
        streamingState?: {
          isStreaming: boolean;
          isProcessing: boolean;
          queueLength: number;
        };
      }
    ).streamingState;

    if (hasStarted) {
      const status = {
        status: "started",
        timestamp: new Date().toISOString(),
        initialized: true,
        streaming: streamingState
          ? {
              isStreaming: streamingState.isStreaming,
              isProcessing: streamingState.isProcessing,
              queueLength: streamingState.queueLength,
            }
          : null,
      };
      this.sendResponse(res, 200, status);
    } else {
      const status = {
        status: "starting",
        timestamp: new Date().toISOString(),
        initialized: false,
        streaming: null,
      };
      this.sendResponse(res, 503, status);
    }
  }

  private sendResponse(
    res: ServerResponse,
    statusCode: number,
    data: Record<string, unknown>,
  ): void {
    res.statusCode = statusCode;
    res.end(JSON.stringify(data, null, 2));
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(
          `Health server listening on ${this.config.host}:${this.config.port}`,
        );
        resolve();
      });

      this.server.on("error", (error) => {
        console.error("Health server error:", error);
        reject(error);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log("Health server stopped");
        resolve();
      });
    });
  }
}
