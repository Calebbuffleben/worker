import fs from 'node:fs/promises';
import path from 'node:path';
import { Job } from 'bullmq';
import { logger } from './logger';
import { TranscodeJobData, TranscodeJobResult } from './types';
import { getObjectStream, putObject } from './r2';
import { probe, transcodeToHls, withTempDir, extractThumbnail, generateThumbnailSprites } from './ffmpeg';
import mime from 'mime';
import axios from 'axios';

export async function handleTranscodeJob(job: Job<TranscodeJobData>): Promise<TranscodeJobResult> {
  const data = job.data;

  const segmentSeconds = data.segmentSeconds ?? 6;
  const crf = data.crf ?? 21;
  const preset = data.preset ?? 'veryfast';
  const ladder = data.ladder ?? [
  //  { width: 1920, height: 1080, videoBitrateKbps: 6000, audioBitrateKbps: 128 }, // 1080p
    { width: 1280, height: 720, videoBitrateKbps: 3000, audioBitrateKbps: 128 },  // 720p
  //  { width: 854, height: 480, videoBitrateKbps: 1500, audioBitrateKbps: 128 },   // 480p
   // { width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 128 },    // 360p
  //  { width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 128 },    // 240p
  ];
  const hlsPath = data.hlsPath ?? 'hls';

  return withTempDir(async (tmp) => {
    // 1) Download original to temp file
    const inputPath = path.join(tmp, 'input');
    const srcKey = data.sourcePath; // absolute key in R2
    const readStream = await getObjectStream(srcKey);
    const write = (await import('node:fs')).createWriteStream(inputPath);
    await new Promise<void>((resolve, reject) => {
      readStream.pipe(write);
      readStream.on('error', reject);
      write.on('error', reject);
      write.on('finish', () => resolve());
    });

    // 2) Probe
    const info = await probe(inputPath);
    logger.info({ info }, 'ffprobe info');

    // 3) Transcode to HLS (MVP: single variant)
    const outDir = path.join(tmp, hlsPath);
    const { masterPath } = await transcodeToHls(inputPath, outDir, {
      variants: ladder.map(x => ({
        width: x.width,
        height: x.height,
        videoBitrateKbps: x.videoBitrateKbps,
        audioBitrateKbps: x.audioBitrateKbps ?? (data.audioBitrateKbps ?? 128),
      })),
      segmentSeconds,
      preset,
      crf,
      audioCodec: 'aac',
    });

    // 4) Upload HLS outputs to R2 under assetKey/hls
    const relativeDir = path.relative(tmp, outDir);
    await uploadDirectory(outDir, `${data.assetKey}/${relativeDir}`);

    const hlsMasterRelative = path.relative(tmp, masterPath).replace(/\\/g, '/');
    const hlsMasterPath = hlsMasterRelative; // Just the relative path: hls/master.m3u8

    // 5) Advanced thumbnails: Generate sprites and VTT
    const thumbsDir = path.join(tmp, 'thumbs');
    await fs.mkdir(thumbsDir, { recursive: true });
    
    try {
      // Generate main thumbnail (first frame)
      const mainThumbPath = path.join(thumbsDir, '0001.jpg');
      await extractThumbnail(inputPath, mainThumbPath, Math.min(1, Math.max(0, Math.floor((info.durationSeconds || 1)/10))));
      const thumbBuf = await fs.readFile(mainThumbPath);
      await putObject(`${data.assetKey}/thumbs/0001.jpg`, thumbBuf, 'image/jpeg');

      // Generate thumbnail sprites for scrubbing
      if (info.durationSeconds > 10) { // Only for videos longer than 10 seconds
        const { spriteFiles, vttFile } = await generateThumbnailSprites(inputPath, thumbsDir, {
          durationSeconds: info.durationSeconds,
          intervalSeconds: Math.max(2, Math.floor(info.durationSeconds / 50)), // ~50 thumbnails max
          spriteColumns: 10,
          spriteRows: 10,
          thumbnailWidth: 160,
          thumbnailHeight: 90,
        });

        // Upload sprites and VTT
        for (const spriteFile of spriteFiles) {
          const spritePath = path.join(thumbsDir, spriteFile);
          const spriteBuffer = await fs.readFile(spritePath);
          await putObject(`${data.assetKey}/thumbs/${spriteFile}`, spriteBuffer, 'image/jpeg');
        }

        // Upload VTT file
        const vttPath = path.join(thumbsDir, vttFile);
        const vttBuffer = await fs.readFile(vttPath);
        await putObject(`${data.assetKey}/thumbs/${vttFile}`, vttBuffer, 'text/vtt');
        
        logger.info(`Uploaded ${spriteFiles.length} sprite files and VTT`);
      }
    } catch (thumbError) {
      logger.warn({ thumbError }, 'Failed to generate thumbnails, continuing...');
    }

    const result: TranscodeJobResult = {
      videoId: data.videoId,
      organizationId: data.organizationId,
      assetKey: data.assetKey,
      hlsMasterPath: hlsMasterPath.replace(/\\/g, '/'),
      durationSeconds: info.durationSeconds,
    };

    // Callback to backend if configured
    if (process.env.BACKEND_API_URL) {
      try {
        // Normalize base so it contains exactly one "/api"
        const base = process.env.BACKEND_API_URL
          .replace(/\/$/, '')
          .replace(/\/api\/api$/, '/api')
          .replace(/([^/])$/, '$1');
        const ensuredApi = base.endsWith('/api') ? base : `${base}/api`;
        const url = `${ensuredApi.replace(/\/$/, '')}/videos/transcode/callback`;
        await axios.post(url, {
          videoId: result.videoId,
          organizationId: result.organizationId,
          assetKey: result.assetKey,
          // Ensure we send only relative path like "hls/master.m3u8"
          hlsMasterPath: typeof result.hlsMasterPath === 'string' && result.hlsMasterPath.includes('/hls/')
            ? result.hlsMasterPath.substring(result.hlsMasterPath.indexOf('hls/'))
            : result.hlsMasterPath,
          durationSeconds: Math.round(result.durationSeconds || 0),
        }, {
          headers: process.env.BACKEND_API_TOKEN ? { Authorization: `Bearer ${process.env.BACKEND_API_TOKEN}` } : undefined,
          timeout: 30000,
        });
        logger.info({ videoId: result.videoId }, 'Callback to backend succeeded');
      } catch (cbErr) {
        logger.error({ err: cbErr }, 'Callback to backend failed');
      }
    } else {
      logger.warn('BACKEND_API_URL not set; skipping callback');
    }

    return result;
  });
}

async function uploadDirectory(localDir: string, destPrefix: string) {
  const entries = await fs.readdir(localDir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(localDir, e.name);
    const key = `${destPrefix}/${e.name}`.replace(/\\/g, '/');
    if (e.isDirectory()) {
      await uploadDirectory(full, key);
    } else {
      const buf = await fs.readFile(full);
      const contentType = mime.getType(e.name) || undefined;
      await putObject(key, buf, contentType);
    }
  }
}


