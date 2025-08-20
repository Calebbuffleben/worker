export type TranscodeJobData = {
  videoId: string;
  organizationId: string;
  assetKey: string; // base path in R2: org/{orgId}/video/{videoId}
  sourcePath: string; // original upload path in R2 under assetKey, e.g., uploads/{org}/{videoId}/input.mp4
  hlsPath?: string; // relative output path, default: hls
  thumbnailsPath?: string; // relative output path, default: thumbs
  ladder?: Array<{
    width: number;
    height: number;
    videoBitrateKbps: number;
    audioBitrateKbps?: number;
    fps?: number; // optional hint
  }>;
  segmentSeconds?: number; // default 6
  crf?: number; // default 21 for quality mode
  preset?: string; // ffmpeg preset, default 'veryfast'
  audioBitrateKbps?: number; // default 128
};

export type TranscodeJobResult = {
  videoId: string;
  organizationId: string;
  assetKey: string;
  hlsMasterPath: string; // e.g., hls/master.m3u8
  thumbnailSamplePath?: string; // e.g., thumbs/0001.jpg
  durationSeconds?: number;
};


