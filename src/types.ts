// Hardware acceleration detection
export interface NvidiaInfo {
  available: boolean;
  gpuCount: number;
  gpuInfo: string[];
  nvencSupported: boolean;
}

// Stream analysis interfaces
export interface StreamAnalysis {
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  codec?: string;
  duration?: number;
}

export interface AdaptiveStreamSettings {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  maxBitrateKbps: number;
  hardwareAcceleration: boolean;
  videoCodec: string;
}
