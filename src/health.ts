import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { botLogger } from "./logger.js";
import type { Client } from "discord.js-selfbot-v13";

export interface HealthProbeConfig {
  port: number;
  host: string;
  timeout: number;
}

export class HealthProbeServer {
  private server: Server | null = null;
  private client: Client;
  private config: HealthProbeConfig;
  private startupTime: number;
  private isReady = false;

  constructor(client: Client, config: HealthProbeConfig) {
    this.client = client;
    this.config = config;
    this.startupTime = Date.now();
  }

  public markReady(): void {
    this.isReady = true;
    botLogger.info("Health probe server marked as ready");
  }

  public async start(): Promise<void> {
    if (this.server) {
      botLogger.warn("Health probe server already started");
      return;
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.setTimeout(this.config.timeout);

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server not initialized"));
        return;
      }

      this.server.listen(this.config.port, this.config.host, () => {
        botLogger.info(`Health probe server started on ${this.config.host}:${this.config.port}`);
        resolve();
      });

      this.server.on("error", (error) => {
        botLogger.error("Health probe server error", error);
        reject(error);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        botLogger.info("Health probe server stopped");
        this.server = null;
        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || "";
    const method = req.method || "GET";

    // Set common headers
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-cache");

    try {
      if (method !== "GET") {
        this.sendError(res, 405, "Method not allowed");
        return;
      }

      switch (url) {
        case "/health/liveness":
        case "/health/live":
          this.handleLiveness(res);
          break;

        case "/health/readiness":
        case "/health/ready":
          this.handleReadiness(res);
          break;

        case "/health/startup":
          this.handleStartup(res);
          break;

        case "/health":
          this.handleHealth(res);
          break;

        default:
          this.sendError(res, 404, "Not found");
          break;
      }
    } catch (error) {
      botLogger.error("Error handling health probe request", error);
      this.sendError(res, 500, "Internal server error");
    }
  }

  private handleLiveness(res: ServerResponse): void {
    // Liveness probe: Is the application alive?
    // This should only fail if the process is completely broken
    const status = {
      status: "alive",
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startupTime,
    };

    res.statusCode = 200;
    res.end(JSON.stringify(status));
  }

  private handleReadiness(res: ServerResponse): void {
    // Readiness probe: Is the application ready to serve requests?
    // Should fail if Discord client is not connected or bot is not functional
    const discordReady = this.client.isReady();
    const ready = this.isReady && discordReady;

    const status = {
      status: ready ? "ready" : "not_ready",
      timestamp: new Date().toISOString(),
      checks: {
        marked_ready: this.isReady,
        discord_connected: discordReady,
        discord_user: this.client.user?.tag || null,
      },
    };

    res.statusCode = ready ? 200 : 503;
    res.end(JSON.stringify(status));
  }

  private handleStartup(res: ServerResponse): void {
    // Startup probe: Is the application starting up successfully?
    // Should pass once the bot has successfully logged in
    const discordReady = this.client.isReady();
    const started = discordReady;

    const status = {
      status: started ? "started" : "starting",
      timestamp: new Date().toISOString(),
      startup_time: Date.now() - this.startupTime,
      checks: {
        discord_connected: discordReady,
        discord_user: this.client.user?.tag || null,
      },
    };

    res.statusCode = started ? 200 : 503;
    res.end(JSON.stringify(status));
  }

  private handleHealth(res: ServerResponse): void {
    // General health endpoint combining all checks
    const discordReady = this.client.isReady();
    const ready = this.isReady && discordReady;
    const started = discordReady;

    const status = {
      status: ready ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startupTime,
      probes: {
        liveness: "alive",
        readiness: ready ? "ready" : "not_ready",
        startup: started ? "started" : "starting",
      },
      checks: {
        marked_ready: this.isReady,
        discord_connected: discordReady,
        discord_user: this.client.user?.tag || null,
      },
    };

    res.statusCode = ready ? 200 : 503;
    res.end(JSON.stringify(status));
  }

  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    const error = {
      error: message,
      timestamp: new Date().toISOString(),
      status_code: statusCode,
    };

    res.statusCode = statusCode;
    res.end(JSON.stringify(error));
  }
}
