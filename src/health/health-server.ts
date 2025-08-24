import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { HealthMonitor } from "./health-monitor.js";
import type { AutoRecoverySystem } from "./auto-recovery.js";
import { botLogger as logger } from "../logger.js";

export interface HealthServerConfig {
  port: number;
  host: string;
  enableRecoveryEndpoints: boolean;
  enableMetrics: boolean;
  timeout: number;
}

export class HealthServer {
  private server: ReturnType<typeof createServer>;
  private healthMonitor: HealthMonitor;
  private recoverySystem: AutoRecoverySystem | undefined;
  private config: HealthServerConfig;
  private isShuttingDown = false;

  constructor(
    healthMonitor: HealthMonitor,
    recoverySystem: AutoRecoverySystem | undefined = undefined,
    config: Partial<HealthServerConfig> = {}
  ) {
    this.healthMonitor = healthMonitor;
    this.recoverySystem = recoverySystem;
    this.config = {
      port: 8080,
      host: "0.0.0.0",
      enableRecoveryEndpoints: false, // Disabled by default for security
      enableMetrics: true, // Enabled by default
      timeout: 10000, // 10 seconds
      ...config,
    };

    this.server = createServer(this.handleRequest.bind(this));
    this.server.timeout = this.config.timeout;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        logger.info("Health server started", {
          port: this.config.port,
          host: this.config.host,
          endpoints: this.getEndpointList(),
        });
        resolve();
      });

      this.server.on("error", (error) => {
        logger.error("Health server error", error);
        reject(error);
      });
    });
  }

  public async stop(): Promise<void> {
    this.isShuttingDown = true;

    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info("Health server stopped");
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();

    try {
      // Set common headers
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      if (this.isShuttingDown) {
        this.sendResponse(res, 503, { error: "Server is shutting down" });
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method || "GET";

      logger.debug("Health server request", {
        method,
        path,
        userAgent: req.headers["user-agent"],
        ip: req.socket.remoteAddress,
      });

      // Route handling
      switch (path) {
        case "/":
        case "/health":
          if (method === "GET") {
            await this.handleHealthCheck(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["GET"]);
          }
          break;

        case "/health/live":
        case "/healthz":
          if (method === "GET") {
            await this.handleLivenessProbe(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["GET"]);
          }
          break;

        case "/health/ready":
        case "/readyz":
          if (method === "GET") {
            await this.handleReadinessProbe(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["GET"]);
          }
          break;

        case "/health/startup":
        case "/startupz":
          if (method === "GET") {
            await this.handleStartupProbe(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["GET"]);
          }
          break;

        case "/metrics":
          this.sendResponse(res, 404, { error: "Metrics endpoint disabled" });
          break;

        case "/health/detailed":
          if (method === "GET") {
            await this.handleDetailedHealth(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["GET"]);
          }
          break;

        case "/recovery/status":
          if (!this.config.enableRecoveryEndpoints || !this.recoverySystem) {
            this.sendResponse(res, 404, {
              error: "Recovery endpoints disabled",
            });
            break;
          }
          if (method === "GET") {
            await this.handleRecoveryStatus(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["GET"]);
          }
          break;

        case "/recovery/trigger":
          if (!this.config.enableRecoveryEndpoints || !this.recoverySystem) {
            this.sendResponse(res, 404, {
              error: "Recovery endpoints disabled",
            });
            break;
          }
          if (method === "POST") {
            await this.handleRecoveryTrigger(req, res);
          } else {
            this.sendMethodNotAllowed(res, ["POST"]);
          }
          break;

        default:
          this.sendResponse(res, 404, {
            error: "Endpoint not found",
            availableEndpoints: this.getEndpointList(),
          });
          break;
      }

      const duration = Date.now() - startTime;
      logger.debug("Health server response", {
        method,
        path,
        statusCode: res.statusCode,
        duration,
      });
    } catch (error) {
      logger.error("Error handling health server request", error);
      this.sendResponse(res, 500, {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Kubernetes Liveness Probe - Should return 200 if the application is running
  private async handleLivenessProbe(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const isLive = this.healthMonitor.isLive();

    if (isLive) {
      this.sendResponse(res, 200, {
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    } else {
      this.sendResponse(res, 503, {
        status: "not live",
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Kubernetes Readiness Probe - Should return 200 if the application is ready to serve traffic
  private async handleReadinessProbe(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const isReady = this.healthMonitor.isReady();
    const metrics = this.healthMonitor.getMetrics();

    if (isReady && metrics.discordConnected) {
      this.sendResponse(res, 200, {
        status: "ready",
        timestamp: new Date().toISOString(),
        uptime: metrics.uptime,
      });
    } else {
      this.sendResponse(res, 503, {
        status: "not ready",
        timestamp: new Date().toISOString(),
        reason: !metrics.discordConnected ? "Discord not connected" : "Bot not ready",
      });
    }
  }

  // Kubernetes Startup Probe - Should return 200 when the application has finished starting
  private async handleStartupProbe(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const metrics = this.healthMonitor.getMetrics();
    const hasStarted = metrics.discordReady && metrics.uptime > 10000; // 10 seconds uptime

    if (hasStarted) {
      this.sendResponse(res, 200, {
        status: "started",
        timestamp: new Date().toISOString(),
        uptime: metrics.uptime,
      });
    } else {
      this.sendResponse(res, 503, {
        status: "starting",
        timestamp: new Date().toISOString(),
        uptime: metrics.uptime,
      });
    }
  }

  // General health check endpoint
  private async handleHealthCheck(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const healthResult = await this.healthMonitor.getCurrentHealthStatus();
      const statusCode = this.getHttpStatusFromHealth(healthResult.status);

      this.sendResponse(res, statusCode, {
        status: healthResult.status,
        timestamp: healthResult.timestamp.toISOString(),
        checks: healthResult.checks,
      });
    } catch (error) {
      logger.error("Health check failed", error);
      this.sendResponse(res, 503, {
        status: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Detailed health information
  private async handleDetailedHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const healthResult = await this.healthMonitor.getCurrentHealthStatus();
      const metrics = this.healthMonitor.getMetrics();
      const streamHistory = this.healthMonitor.getStreamQualityHistory();

      const detailed = {
        health: {
          status: healthResult.status,
          timestamp: healthResult.timestamp.toISOString(),
          checks: healthResult.checks,
        },
        metrics: {
          ...metrics,
          timestamp: metrics.timestamp.toISOString(),
          memoryUsage: {
            ...metrics.memoryUsage,
            rssFormated: `${(metrics.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
            heapUsedFormatted: `${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
            heapTotalFormatted: `${(metrics.memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
          },
          uptimeFormatted: this.formatUptime(metrics.uptime),
        },
        streamQuality: {
          history: streamHistory.slice(-10), // Last 10 entries
          current: streamHistory[streamHistory.length - 1] || null,
        },
        recovery: this.recoverySystem ? this.recoverySystem.getRecoveryStats() : null,
      };

      const statusCode = this.getHttpStatusFromHealth(healthResult.status);
      this.sendResponse(res, statusCode, detailed);
    } catch (error) {
      logger.error("Detailed health check failed", error);
      this.sendResponse(res, 503, {
        status: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Recovery system status
  private async handleRecoveryStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.recoverySystem) {
      this.sendResponse(res, 404, { error: "Recovery system not available" });
      return;
    }

    const stats = this.recoverySystem.getRecoveryStats();
    const history = this.recoverySystem.getRecoveryHistory().slice(-20); // Last 20 attempts

    this.sendResponse(res, 200, {
      stats,
      recentHistory: history,
      availableActions: this.recoverySystem.getAvailableActions(),
    });
  }

  // Trigger recovery actions (dangerous - should be protected)
  private async handleRecoveryTrigger(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.recoverySystem) {
      this.sendResponse(res, 404, { error: "Recovery system not available" });
      return;
    }

    try {
      const body = await this.readRequestBody(req);
      const data = JSON.parse(body);

      if (!data.actions || !Array.isArray(data.actions)) {
        this.sendResponse(res, 400, {
          error: "Invalid request",
          message: "Expected 'actions' array in request body",
        });
        return;
      }

      const results = await this.recoverySystem.forceRecovery(data.actions);

      this.sendResponse(res, 200, {
        message: "Recovery triggered",
        results: results,
      });
    } catch (error) {
      logger.error("Recovery trigger failed", error);
      this.sendResponse(res, 400, {
        error: "Recovery trigger failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        resolve(body);
      });
      req.on("error", reject);
    });
  }

  private sendResponse(res: ServerResponse, statusCode: number, data: any): void {
    res.statusCode = statusCode;
    res.end(JSON.stringify(data, null, 2));
  }

  private sendMethodNotAllowed(res: ServerResponse, allowedMethods: string[]): void {
    res.setHeader("Allow", allowedMethods.join(", "));
    this.sendResponse(res, 405, {
      error: "Method not allowed",
      allowedMethods,
    });
  }

  private getHttpStatusFromHealth(healthStatus: "healthy" | "degraded" | "unhealthy"): number {
    switch (healthStatus) {
      case "healthy":
        return 200;
      case "degraded":
        return 200; // Still serving traffic but with warnings
      case "unhealthy":
        return 503;
      default:
        return 503;
    }
  }

  private formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  private getEndpointList(): string[] {
    const endpoints = [
      "GET /health - General health check",
      "GET /health/live - Kubernetes liveness probe",
      "GET /health/ready - Kubernetes readiness probe",
      "GET /health/startup - Kubernetes startup probe",
      "GET /health/detailed - Detailed health information",
    ];

    if (this.config.enableMetrics) {
      endpoints.push("GET /metrics - Prometheus metrics");
    }

    if (this.config.enableRecoveryEndpoints && this.recoverySystem) {
      endpoints.push("GET /recovery/status - Recovery system status");
      endpoints.push("POST /recovery/trigger - Trigger recovery actions");
    }

    return endpoints;
  }
}
