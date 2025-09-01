import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpeg from 'fluent-ffmpeg';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { logger } from './logger';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export type ProbeInfo = {
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  audioChannels?: number;
  audioSampleRate?: number;
};

export async function probe(filePath: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ffmpeg as any).ffprobe(filePath, (err: unknown, data: any) => {
      if (err) return reject(err);
      const vStream = data.streams?.find((s: any) => s.codec_type === 'video');
      const aStream = data.streams?.find((s: any) => s.codec_type === 'audio');
      const rFrameRate = vStream?.r_frame_rate && vStream.r_frame_rate.includes('/')
        ? (() => {
            const [num, den] = vStream!.r_frame_rate.split('/').map(Number);
            return den ? num / den : undefined;
          })()
        : undefined;
      resolve({
        durationSeconds: Number(data.format?.duration || 0),
        width: vStream?.width,
        height: vStream?.height,
        fps: rFrameRate,
        hasAudio: Boolean(aStream),
        audioChannels: aStream?.channels,
        audioSampleRate: aStream?.sample_rate ? Number(aStream.sample_rate) : undefined,
      });
    });
  });
}

export type HlsVariant = {
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
};

export type HlsOptions = {
  variants: HlsVariant[];
  segmentSeconds: number; // e.g., 6
  preset: string; // e.g., 'veryfast'
  crf?: number; // if using CRF mode
  audioCodec?: string; // 'aac'
  videoFps?: number; // detected fps to tune GOP/level
  includeAudio?: boolean; // whether input has audio
  audioChannels?: number; // channels to encode when includeAudio
};

export async function transcodeToHls(
  inputFile: string,
  destinationDir: string,
  options: HlsOptions,
): Promise<{ masterPath: string }> {
  // Ensure destination exists
  await fs.mkdir(destinationDir, { recursive: true });

  const masterPath = path.join(destinationDir, 'master.m3u8');
  const variantPlaylists: Array<{
    width: number;
    height: number;
    bandwidth: number;
    playlistPath: string;
    codecs: string;
  }> = [];

  // Process each variant sequentially to avoid resource conflicts
  const audioCodecRfc6381 = 'mp4a.40.2'; // AAC-LC
  const fps = Math.max(1, Math.round((options.videoFps || 24)));

  for (let i = 0; i < options.variants.length; i++) {
    const variant = options.variants[i];
    const playlistName = `variant_${variant.height}p.m3u8`;
    const playlistPath = path.join(destinationDir, playlistName);
    const segmentPrefix = `segment_${variant.height}p_%03d.ts`;
    
    const vBitrate = `${variant.videoBitrateKbps}k`;
    const aBitrate = `${variant.audioBitrateKbps}k`;
    
    // Calculate total bandwidth (video + audio + overhead ~10%)
    const totalBandwidth = Math.round((variant.videoBitrateKbps + variant.audioBitrateKbps) * 1100);

    logger.info(`Transcoding variant ${i + 1}/${options.variants.length}: ${variant.width}x${variant.height} @ ${vBitrate}`);

    await new Promise<void>((resolve, reject) => {
      // Choose H.264 level based on resolution and fps
      // 720p@<=30fps -> 4.0, 720p@>30fps -> 4.1
      const needsHighFps = variant.height >= 720 && fps > 30;
      const h264Level = needsHighFps ? '4.1' : '4.0';
      const videoCodecRfc6381 = needsHighFps ? 'avc1.4d4029' : 'avc1.4d4028';
      const gopSize = Math.max(24, Math.round(fps * options.segmentSeconds));

      const command = ffmpeg(inputFile)
        .videoCodec('libx264')
        .audioCodec(options.includeAudio ? (options.audioCodec || 'aac') : undefined as any)
        .videoFilters(`scale=${variant.width}:${variant.height}`)
        .outputOptions((() => {
          const opts: string[] = [];
          opts.push(`-preset ${options.preset}`);
          if (options.crf != null) {
            opts.push(`-crf ${options.crf}`);
          } else {
            opts.push(`-b:v ${vBitrate}`);
          }
          opts.push('-profile:v main');
          opts.push(`-level:v ${h264Level}`);
          opts.push('-sc_threshold 0');
          opts.push(`-g ${gopSize}`);
          opts.push(`-keyint_min ${gopSize}`);
          opts.push('-pix_fmt yuv420p');
          // Stream mapping
          opts.push('-map 0:v:0');
          if (options.includeAudio) {
            opts.push('-map 0:a:0?');
            opts.push(`-b:a ${aBitrate}`);
            opts.push('-ar 48000');
            opts.push(`-ac ${Math.max(1, Math.min(2, options.audioChannels || 2))}`);
          } else {
            opts.push('-an');
          }
          opts.push('-sn');
          opts.push('-dn');
          opts.push('-map_metadata -1');
          opts.push('-map_chapters -1');
          opts.push(`-force_key_frames expr:gte(t,n_forced*${options.segmentSeconds})`);
          // HLS options
          opts.push(`-hls_time ${options.segmentSeconds}`);
          opts.push('-hls_playlist_type vod');
          opts.push('-hls_flags independent_segments');
          opts.push('-hls_segment_type mpegts');
          opts.push('-hls_list_size 0');
          opts.push(`-hls_segment_filename ${path.join(destinationDir, segmentPrefix)}`);
          return opts;
        })())
        .output(playlistPath)
        .format('hls')
        .on('start', (cmd: string) => logger.info({ cmd }, `ffmpeg start variant ${variant.height}p`))
        .on('progress', (p: { frames?: number; timemark?: string }) => 
          logger.info({ frames: p.frames, timemark: p.timemark }, `ffmpeg progress ${variant.height}p`)
        )
        .on('error', (err: unknown) => {
          logger.error({ 
            err, 
            variant: `${variant.width}x${variant.height}`,
            inputFile,
            outputPath: playlistPath,
            command: command._getArguments?.() || 'unknown'
          }, `ffmpeg error variant ${variant.height}p`);
          reject(err);
        })
        .on('end', () => {
          logger.info(`ffmpeg finished variant ${variant.height}p`);
          resolve();
        });

      command.run();
    });

    variantPlaylists.push({
      width: variant.width,
      height: variant.height,
      bandwidth: totalBandwidth,
      playlistPath: playlistName,
      codecs: options.includeAudio
        ? `${(variant.height >= 720 && fps > 30) ? 'avc1.4d4029' : 'avc1.4d4028'},${audioCodecRfc6381}`
        : `${(variant.height >= 720 && fps > 30) ? 'avc1.4d4029' : 'avc1.4d4028'}`,
    });
  }

  // Generate master playlist
  const masterContent = generateMasterPlaylist(variantPlaylists);
  await fs.writeFile(masterPath, masterContent);
  
  logger.info(`Generated master playlist with ${variantPlaylists.length} variants`);

  return { masterPath };
}

function generateMasterPlaylist(variants: Array<{
  width: number;
  height: number;
  bandwidth: number;
  playlistPath: string;
  codecs?: string;
}>): string {
  let content = '#EXTM3U\n#EXT-X-VERSION:6\n\n';
  
  // Sort variants by quality (highest first)
  const sortedVariants = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
  
  for (const variant of sortedVariants) {
    const codecsAttr = variant.codecs ? `,CODECS="${variant.codecs}"` : '';
    content += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}${codecsAttr}\n`;
    content += `${variant.playlistPath}\n\n`;
  }
  
  return content;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcode-'));
  try {
    return await fn(dir);
  } finally {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }
}

export async function extractThumbnail(inputFile: string, outputFile: string, seekSeconds: number = 1): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg(inputFile)
      .seekInput(Math.max(0, seekSeconds))
      .frames(1)
      .outputOptions(['-qscale:v 2'])
      .output(outputFile)
      .on('start', (cmd: string) => logger.info({ cmd }, 'ffmpeg thumbnail start'))
      .on('error', (err: unknown) => {
        logger.error({ err }, 'ffmpeg thumbnail error');
        reject(err);
      })
      .on('end', () => resolve());
    command.run();
  });
}

export type ThumbnailOptions = {
  durationSeconds: number;
  intervalSeconds: number; // Generate thumbnail every X seconds
  spriteColumns: number;   // Number of columns in sprite
  spriteRows: number;      // Number of rows in sprite
  thumbnailWidth: number;  // Width of each thumbnail
  thumbnailHeight: number; // Height of each thumbnail
};

export async function generateThumbnailSprites(
  inputFile: string, 
  outputDir: string, 
  options: ThumbnailOptions
): Promise<{ spriteFiles: string[]; vttFile: string }> {
  await fs.mkdir(outputDir, { recursive: true });
  
  const { durationSeconds, intervalSeconds, spriteColumns, spriteRows } = options;
  const { thumbnailWidth, thumbnailHeight } = options;
  
  const totalThumbnails = Math.floor(durationSeconds / intervalSeconds);
  const thumbnailsPerSprite = spriteColumns * spriteRows;
  const numberOfSprites = Math.ceil(totalThumbnails / thumbnailsPerSprite);
  
  logger.info(`Generating ${totalThumbnails} thumbnails in ${numberOfSprites} sprite(s)`);
  
  const spriteFiles: string[] = [];
  const vttEntries: string[] = [];
  
  // Generate sprites
  for (let spriteIndex = 0; spriteIndex < numberOfSprites; spriteIndex++) {
    const spriteFile = path.join(outputDir, `sprite_${spriteIndex}.jpg`);
    const startThumb = spriteIndex * thumbnailsPerSprite;
    const endThumb = Math.min(startThumb + thumbnailsPerSprite, totalThumbnails);
    const actualThumbnails = endThumb - startThumb;
    
    // Generate individual thumbnails for this sprite
    const tempThumbs: string[] = [];
    for (let i = 0; i < actualThumbnails; i++) {
      const thumbIndex = startThumb + i;
      const timeSeconds = thumbIndex * intervalSeconds;
      const tempThumbFile = path.join(outputDir, `temp_thumb_${thumbIndex}.jpg`);
      
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputFile)
          .seekInput(timeSeconds)
          .frames(1)
          .size(`${thumbnailWidth}x${thumbnailHeight}`)
          .outputOptions(['-qscale:v 2'])
          .output(tempThumbFile)
          .on('error', reject)
          .on('end', resolve)
          .run();
      });
      
      tempThumbs.push(tempThumbFile);
      
      // Generate VTT entry
      const startTime = formatVttTime(timeSeconds);
      const endTime = formatVttTime(timeSeconds + intervalSeconds);
      const xPos = (i % spriteColumns) * thumbnailWidth;
      const yPos = Math.floor(i / spriteColumns) * thumbnailHeight;
      
      vttEntries.push(
        `${startTime} --> ${endTime}`,
        `sprite_${spriteIndex}.jpg#xywh=${xPos},${yPos},${thumbnailWidth},${thumbnailHeight}`,
        ''
      );
    }
    
    // Create sprite image using ImageMagick montage command (fallback to manual grid)
    const spriteWidth = spriteColumns * thumbnailWidth;
    const spriteHeight = Math.ceil(actualThumbnails / spriteColumns) * thumbnailHeight;
    
    // Use FFmpeg to create the sprite montage
    await createSpriteWithFFmpeg(tempThumbs, spriteFile, spriteColumns, thumbnailWidth, thumbnailHeight);
    
    // Clean up temp thumbnails
    for (const tempFile of tempThumbs) {
      await fs.unlink(tempFile).catch(() => {});
    }
    
    spriteFiles.push(`sprite_${spriteIndex}.jpg`);
    logger.info(`Generated sprite ${spriteIndex + 1}/${numberOfSprites}: ${path.basename(spriteFile)}`);
  }
  
  // Generate VTT file
  const vttContent = [
    'WEBVTT',
    '',
    ...vttEntries
  ].join('\n');
  
  const vttFile = path.join(outputDir, 'thumbnails.vtt');
  await fs.writeFile(vttFile, vttContent);
  
  logger.info(`Generated VTT file with ${totalThumbnails} thumbnail entries`);
  
  return { spriteFiles, vttFile: 'thumbnails.vtt' };
}

async function createSpriteWithFFmpeg(
  thumbnailFiles: string[], 
  outputFile: string, 
  columns: number, 
  thumbWidth: number, 
  thumbHeight: number
): Promise<void> {
  // For simplicity, we'll use a basic grid layout with FFmpeg filter
  // In production, you might want to use ImageMagick for better control
  
  if (thumbnailFiles.length === 0) return;
  
  // For now, create a simple horizontal strip and let the client handle the grid
  // This is a simplified version - in production you'd want proper sprite generation
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg();
    
    // Add all thumbnail inputs
    thumbnailFiles.forEach(file => command.input(file));
    
    // Create a filter for horizontal concatenation (simplified)
    const filterComplex = thumbnailFiles.length > 1 
      ? `hstack=inputs=${thumbnailFiles.length}`
      : 'copy';
    
    command
      .complexFilter([filterComplex])
      .output(outputFile)
      .on('error', reject)
      .on('end', resolve)
      .run();
  });
}

function formatVttTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}


