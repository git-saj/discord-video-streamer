import { spawn } from "node:child_process";
import type { StreamAnalysis } from "./types.js";
import { streamLogger } from "./logger.js";

export async function analyzeInputStream(url: string): Promise<StreamAnalysis> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-select_streams",
      "v:0",
      "-analyzeduration",
      "5000000",
      "-probesize",
      "5000000",
      url,
    ]);

    let output = "";
    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`));
        return;
      }

      try {
        const probe = JSON.parse(output);
        const videoStream = probe.streams[0];

        if (!videoStream) {
          reject(new Error("No video stream found"));
          return;
        }

        // Calculate FPS from various possible fields
        let fps = 30; // Default fallback
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
          if (den && den !== 0) fps = Math.round(num / den);
        } else if (videoStream.avg_frame_rate) {
          const [num, den] = videoStream.avg_frame_rate.split("/").map(Number);
          if (den && den !== 0) fps = Math.round(num / den);
        }

        // Sanitize FPS to reasonable values
        fps = Math.min(Math.max(fps, 15), 120);

        const analysis: StreamAnalysis = {
          width: videoStream.width || 1280,
          height: videoStream.height || 720,
          fps: fps,
          ...(videoStream.bit_rate && {
            bitrate: parseInt(videoStream.bit_rate, 10),
          }),
          ...(videoStream.codec_name && { codec: videoStream.codec_name }),
          ...(videoStream.duration && {
            duration: parseFloat(videoStream.duration),
          }),
        };

        streamLogger.info("Input stream analyzed", {
          originalResolution: `${analysis.width}x${analysis.height}`,
          originalFps: analysis.fps,
          originalCodec: analysis.codec,
          originalBitrate: analysis.bitrate
            ? `${Math.round(analysis.bitrate / 1000)}kbps`
            : "unknown",
        });

        resolve(analysis);
      } catch (error) {
        reject(new Error(`Failed to parse ffprobe output: ${error}`));
      }
    });

    ffprobe.on("error", (error) => {
      reject(new Error(`ffprobe error: ${error.message}`));
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      ffprobe.kill();
      reject(new Error("Stream analysis timed out"));
    }, 15000);
  });
}

export function generateOptimalSettings(
  analysis: StreamAnalysis,
  hardwareAccel: boolean
): {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  maxBitrateKbps: number;
} {
  const { width, height, fps } = analysis;

  // Determine optimal resolution based on input - preserve 4K for hardware acceleration
  let targetWidth = width;
  let targetHeight = height;

  // Cap maximum resolution to 1440p for all streams above 1440p
  if (width > 2560 || height > 1440) {
    // Anything above 1440p -> cap to 1440p
    targetWidth = 2560;
    targetHeight = 1440;
  } else if (width > 1920 || height > 1080) {
    // 1080p+ -> keep original resolution
    targetWidth = width;
    targetHeight = height;
  }
  // Keep anything 1080p and below as-is

  // Ensure even dimensions for video encoding
  targetWidth = Math.floor(targetWidth / 2) * 2;
  targetHeight = Math.floor(targetHeight / 2) * 2;

  // Preserve high framerates for better motion
  let targetFps = Math.min(fps, 60);
  if (targetFps > 50) targetFps = 60;
  else if (targetFps > 40) targetFps = 50;
  else if (targetFps > 30) {
    // Keep original if between 30-40
  } else if (targetFps > 25) targetFps = 30;
  else targetFps = 25;

  // Calculate bitrate based on resolution and framerate
  const pixelCount = targetWidth * targetHeight;
  let baseBitrate: number;

  if (pixelCount >= 3686400) {
    // 1440p+
    baseBitrate = hardwareAccel ? 6000 : 4000;
  } else if (pixelCount >= 2073600) {
    // 1080p
    baseBitrate = hardwareAccel ? 4000 : 3000;
  } else if (pixelCount >= 921600) {
    // 720p
    baseBitrate = hardwareAccel ? 2500 : 2000;
  } else {
    // 480p and below
    baseBitrate = hardwareAccel ? 1500 : 1000;
  }

  // Adjust for framerate - higher FPS needs more bitrate
  let fpsMultiplier = 1.0;
  if (targetFps >= 50) {
    fpsMultiplier = 1.6; // 50-60 FPS needs significantly more bitrate
  } else if (targetFps > 30) {
    fpsMultiplier = 1.3; // 30+ FPS needs moderate increase
  }

  const targetBitrate = Math.round(baseBitrate * fpsMultiplier);
  const maxBitrate = Math.round(targetBitrate * 1.3); // Reduced from 1.5 to avoid excessive spikes

  streamLogger.info("Generated optimal settings", {
    inputResolution: `${width}x${height}`,
    outputResolution: `${targetWidth}x${targetHeight}`,
    inputFps: fps,
    outputFps: targetFps,
    bitrate: `${targetBitrate}kbps`,
    maxBitrate: `${maxBitrate}kbps`,
    hardwareAcceleration: hardwareAccel,
  });

  return {
    width: targetWidth,
    height: targetHeight,
    fps: targetFps,
    bitrateKbps: targetBitrate,
    maxBitrateKbps: maxBitrate,
  };
}
