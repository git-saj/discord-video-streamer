import fs from "node:fs";
import { execSync } from "node:child_process";
import type { NvidiaInfo } from "./types.js";
import { streamLogger } from "./logger.js";
import type { StreamConfig } from "./config.js";

export async function detectNvidiaCapabilities(): Promise<NvidiaInfo> {
  const result: NvidiaInfo = {
    available: false,
    gpuCount: 0,
    gpuInfo: [],
    nvencSupported: false,
  };

  try {
    // Check for NVIDIA devices in container (fallback method)
    // Check if NVIDIA devices are available
    const nvidiaDevices = ["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm"];

    let deviceCount = 0;
    for (const device of nvidiaDevices) {
      try {
        if (fs.existsSync(device)) {
          deviceCount++;
        }
      } catch {
        // Ignore individual device check failures
      }
    }

    if (deviceCount >= 2) {
      // At least nvidia0 and nvidiactl
      result.available = true;
      result.gpuCount = 1; // Assume 1 GPU for now
      result.gpuInfo = ["NVIDIA GPU (detected via device files)"];
    }

    // Check for NVENC support by testing ffmpeg encoders
    try {
      const ffmpegOutput = execSync("ffmpeg -hide_banner -encoders", {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      result.nvencSupported = ffmpegOutput.includes("h264_nvenc") || ffmpegOutput.includes("nvenc");
    } catch {
      result.nvencSupported = false;
    }
  } catch (error) {
    streamLogger.warn("NVIDIA GPU detection failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return result;
}

export async function logHardwareAcceleration(config: StreamConfig): Promise<void> {
  if (!config.hardwareAcceleration) {
    streamLogger.info("Hardware acceleration disabled in config");
    return;
  }

  const nvidiaInfo = await detectNvidiaCapabilities();

  if (nvidiaInfo.available) {
    streamLogger.info("NVIDIA GPU detected for hardware acceleration", {
      gpuCount: nvidiaInfo.gpuCount,
      nvencSupported: nvidiaInfo.nvencSupported,
      gpus: nvidiaInfo.gpuInfo,
    });

    if (!nvidiaInfo.nvencSupported) {
      streamLogger.warn(
        "NVENC encoder not detected in FFmpeg - will fall back to software encoding"
      );
    }
  } else {
    streamLogger.warn("Hardware acceleration enabled but no NVIDIA GPU detected");
  }
}
