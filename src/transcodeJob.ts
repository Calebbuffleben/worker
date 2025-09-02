import fs from 'node:fs/promises';
import path from 'node:path';
import { Job } from 'bullmq';
import { logger } from './logger';
import { TranscodeJobData, TranscodeJobResult } from './types';
import { getObjectStream, putObject, removeObject } from './r2';
import { probe, transcodeToHls, withTempDir, extractThumbnail, generateThumbnailSprites } from './ffmpeg';
import mime from 'mime';
import axios from 'axios';

export async function handleTranscodeJob(job: Job<TranscodeJobData>): Promise<TranscodeJobResult> {
  const data = job.data;
  // Ajustar segmentSeconds baseado na duração do vídeo
  let segmentSeconds = data.segmentSeconds ?? 6;
  
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

    // Ajustar segmentSeconds baseado na duração real do vídeo
    if (info.durationSeconds && info.durationSeconds > 1800) { // > 30 minutos
      segmentSeconds = 2;
      logger.info(`Video duration: ${info.durationSeconds}s, using ${segmentSeconds}s segments for very long video`);
    } else if (info.durationSeconds && info.durationSeconds > 600) { // > 10 minutos
      segmentSeconds = 4;
      logger.info(`Video duration: ${info.durationSeconds}s, using ${segmentSeconds}s segments`);
    }

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
      videoFps: info.fps,
      includeAudio: info.hasAudio === true,
      audioChannels: info.audioChannels ?? 2,
    });

    // 4) Upload HLS outputs to R2 under assetKey/hls
    const relativeDir = path.relative(tmp, outDir);
    await uploadDirectory(outDir, `${data.assetKey}/${relativeDir}`);

    const hlsMasterRelative = path.relative(tmp, masterPath).replace(/\\/g, '/');
    const hlsMasterPath = hlsMasterRelative; // Just the relative path: hls/master.m3u8

    // 5) Thumbnail única para capa
    const thumbsDir = path.join(tmp, 'thumbs');
    await fs.mkdir(thumbsDir, { recursive: true });
    try {
      const mainThumbPath = path.join(thumbsDir, '0001.jpg');
      const midSecond = Math.max(1, Math.floor((info.durationSeconds || 2) / 2));
      await extractThumbnail(inputPath, mainThumbPath, midSecond, 1280);
      const thumbBuf = await fs.readFile(mainThumbPath);
      await putObject(`${data.assetKey}/thumbs/0001.jpg`, thumbBuf, 'image/jpeg');
    } catch (thumbError) {
      logger.warn({ thumbError }, 'Failed to generate thumbnail, continuing...');
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
      const maxCallbackRetries = 5;
      let callbackSuccess = false;
      
      // Normalize base so it contains exactly one "/api" - moved outside loop for rollback use
      const base = process.env.BACKEND_API_URL
        .replace(/\/$/, '')
        .replace(/\/api\/api$/, '/api')
        .replace(/([^/])$/, '$1');
      const ensuredApi = base.endsWith('/api') ? base : `${base}/api`;
      
      for (let attempt = 1; attempt <= maxCallbackRetries && !callbackSuccess; attempt++) {
        try {
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
          
          logger.info({ videoId: result.videoId, attempt }, 'Callback to backend succeeded');
          callbackSuccess = true;
        } catch (cbErr) {
          if (attempt === maxCallbackRetries) {
            logger.error({ err: cbErr, attempt, videoId: result.videoId }, 'Callback to backend failed after all retries');
            
            // ROLLBACK COMPLETO: Remover vídeo do R2 e notificar falha
            try {
              logger.warn({ videoId: result.videoId }, 'Starting complete rollback - removing video from R2');
              
              // Remover HLS files
              await removeObject(`${data.assetKey}/hls/master.m3u8`);
              await removeObject(`${data.assetKey}/hls/segment_720p_000.ts`);
              await removeObject(`${data.assetKey}/hls/segment_720p_001.ts`);
              // ... outros segmentos serão removidos pelo backend
              
              // Remover thumbnail
              await removeObject(`${data.assetKey}/thumbs/0001.jpg`);
              
              // Notificar backend sobre falha
              const failureUrl = `${ensuredApi.replace(/\/$/, '')}/videos/transcode/failure`;
              await axios.post(failureUrl, {
                videoId: result.videoId,
                organizationId: result.organizationId,
                assetKey: data.assetKey,
                error: 'Callback failed after 5 attempts - video removed from R2',
                timestamp: new Date().toISOString(),
              }, {
                headers: process.env.BACKEND_API_TOKEN ? { Authorization: `Bearer ${process.env.BACKEND_API_TOKEN}` } : undefined,
                timeout: 30000,
              });
              
              logger.info({ videoId: result.videoId }, 'Rollback completed - failure notified to backend');
            } catch (rollbackErr) {
              logger.error({ err: rollbackErr, videoId: result.videoId }, 'Rollback failed - manual intervention required');
            }
            
            // FALHAR O JOB para triggerar retry automático do BullMQ
            throw new Error(`Callback failed after ${maxCallbackRetries} attempts - video rolled back from R2`);
          } else {
            logger.warn({ err: cbErr, attempt, videoId: result.videoId }, `Callback to backend failed, retrying... (${attempt}/${maxCallbackRetries})`);
            // Wait before retry (exponential backoff: 2s, 4s, 8s, 16s, 32s)
            await new Promise(resolve => setTimeout(resolve, 2000 * Math.pow(2, attempt - 1)));
          }
        }
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


