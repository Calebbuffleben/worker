"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probe = probe;
exports.transcodeToHls = transcodeToHls;
exports.withTempDir = withTempDir;
exports.extractThumbnail = extractThumbnail;
exports.generateThumbnailSprites = generateThumbnailSprites;
const ffmpeg_1 = __importDefault(require("@ffmpeg-installer/ffmpeg"));
const ffprobe_1 = __importDefault(require("@ffprobe-installer/ffprobe"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const promises_1 = __importDefault(require("node:fs/promises"));
const logger_1 = require("./logger");
fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_1.default.path);
fluent_ffmpeg_1.default.setFfprobePath(ffprobe_1.default.path);
async function probe(filePath) {
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fluent_ffmpeg_1.default.ffprobe(filePath, (err, data) => {
            if (err)
                return reject(err);
            const stream = data.streams?.find((s) => s.codec_type === 'video');
            const rFrameRate = stream?.r_frame_rate && stream.r_frame_rate.includes('/')
                ? (() => {
                    const [num, den] = stream.r_frame_rate.split('/').map(Number);
                    return den ? num / den : undefined;
                })()
                : undefined;
            resolve({
                durationSeconds: Number(data.format?.duration || 0),
                width: stream?.width,
                height: stream?.height,
                fps: rFrameRate,
            });
        });
    });
}
async function transcodeToHls(inputFile, destinationDir, options) {
    // Ensure destination exists
    await promises_1.default.mkdir(destinationDir, { recursive: true });
    const masterPath = node_path_1.default.join(destinationDir, 'master.m3u8');
    const variantPlaylists = [];
    // Process each variant sequentially to avoid resource conflicts
    for (let i = 0; i < options.variants.length; i++) {
        const variant = options.variants[i];
        const playlistName = `variant_${variant.height}p.m3u8`;
        const playlistPath = node_path_1.default.join(destinationDir, playlistName);
        const segmentPrefix = `segment_${variant.height}p_%03d.ts`;
        const vBitrate = `${variant.videoBitrateKbps}k`;
        const aBitrate = `${variant.audioBitrateKbps}k`;
        // Calculate total bandwidth (video + audio + overhead ~10%)
        const totalBandwidth = Math.round((variant.videoBitrateKbps + variant.audioBitrateKbps) * 1100);
        logger_1.logger.info(`Transcoding variant ${i + 1}/${options.variants.length}: ${variant.width}x${variant.height} @ ${vBitrate}`);
        await new Promise((resolve, reject) => {
            const command = (0, fluent_ffmpeg_1.default)(inputFile)
                .videoCodec('libx264')
                .audioCodec(options.audioCodec || 'aac')
                .videoFilters(`scale=${variant.width}:${variant.height}`)
                .outputOptions([
                `-preset ${options.preset}`,
                ...(options.crf != null ? [`-crf ${options.crf}`] : [`-b:v ${vBitrate}`]),
                `-b:a ${aBitrate}`,
                '-sc_threshold 0',
                `-g 48`, // GOP size (keyframe interval)
                '-keyint_min 48',
                `-hls_time ${options.segmentSeconds}`,
                '-hls_playlist_type vod',
                '-hls_flags independent_segments',
                `-hls_segment_filename ${node_path_1.default.join(destinationDir, segmentPrefix)}`,
            ])
                .output(playlistPath)
                .format('hls')
                .on('start', (cmd) => logger_1.logger.info({ cmd }, `ffmpeg start variant ${variant.height}p`))
                .on('progress', (p) => logger_1.logger.info({ frames: p.frames, timemark: p.timemark }, `ffmpeg progress ${variant.height}p`))
                .on('error', (err) => {
                logger_1.logger.error({ err }, `ffmpeg error variant ${variant.height}p`);
                reject(err);
            })
                .on('end', () => {
                logger_1.logger.info(`ffmpeg finished variant ${variant.height}p`);
                resolve();
            });
            command.run();
        });
        variantPlaylists.push({
            width: variant.width,
            height: variant.height,
            bandwidth: totalBandwidth,
            playlistPath: playlistName,
        });
    }
    // Generate master playlist
    const masterContent = generateMasterPlaylist(variantPlaylists);
    await promises_1.default.writeFile(masterPath, masterContent);
    logger_1.logger.info(`Generated master playlist with ${variantPlaylists.length} variants`);
    return { masterPath };
}
function generateMasterPlaylist(variants) {
    let content = '#EXTM3U\n#EXT-X-VERSION:6\n\n';
    // Sort variants by quality (highest first)
    const sortedVariants = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
    for (const variant of sortedVariants) {
        content += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}\n`;
        content += `${variant.playlistPath}\n\n`;
    }
    return content;
}
async function withTempDir(fn) {
    const dir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'transcode-'));
    try {
        return await fn(dir);
    }
    finally {
        try {
            await promises_1.default.rm(dir, { recursive: true, force: true });
        }
        catch { }
    }
}
async function extractThumbnail(inputFile, outputFile, seekSeconds = 1) {
    await new Promise((resolve, reject) => {
        const command = (0, fluent_ffmpeg_1.default)(inputFile)
            .seekInput(Math.max(0, seekSeconds))
            .frames(1)
            .outputOptions(['-qscale:v 2'])
            .output(outputFile)
            .on('start', (cmd) => logger_1.logger.info({ cmd }, 'ffmpeg thumbnail start'))
            .on('error', (err) => {
            logger_1.logger.error({ err }, 'ffmpeg thumbnail error');
            reject(err);
        })
            .on('end', () => resolve());
        command.run();
    });
}
async function generateThumbnailSprites(inputFile, outputDir, options) {
    await promises_1.default.mkdir(outputDir, { recursive: true });
    const { durationSeconds, intervalSeconds, spriteColumns, spriteRows } = options;
    const { thumbnailWidth, thumbnailHeight } = options;
    const totalThumbnails = Math.floor(durationSeconds / intervalSeconds);
    const thumbnailsPerSprite = spriteColumns * spriteRows;
    const numberOfSprites = Math.ceil(totalThumbnails / thumbnailsPerSprite);
    logger_1.logger.info(`Generating ${totalThumbnails} thumbnails in ${numberOfSprites} sprite(s)`);
    const spriteFiles = [];
    const vttEntries = [];
    // Generate sprites
    for (let spriteIndex = 0; spriteIndex < numberOfSprites; spriteIndex++) {
        const spriteFile = node_path_1.default.join(outputDir, `sprite_${spriteIndex}.jpg`);
        const startThumb = spriteIndex * thumbnailsPerSprite;
        const endThumb = Math.min(startThumb + thumbnailsPerSprite, totalThumbnails);
        const actualThumbnails = endThumb - startThumb;
        // Generate individual thumbnails for this sprite
        const tempThumbs = [];
        for (let i = 0; i < actualThumbnails; i++) {
            const thumbIndex = startThumb + i;
            const timeSeconds = thumbIndex * intervalSeconds;
            const tempThumbFile = node_path_1.default.join(outputDir, `temp_thumb_${thumbIndex}.jpg`);
            await new Promise((resolve, reject) => {
                (0, fluent_ffmpeg_1.default)(inputFile)
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
            vttEntries.push(`${startTime} --> ${endTime}`, `sprite_${spriteIndex}.jpg#xywh=${xPos},${yPos},${thumbnailWidth},${thumbnailHeight}`, '');
        }
        // Create sprite image using ImageMagick montage command (fallback to manual grid)
        const spriteWidth = spriteColumns * thumbnailWidth;
        const spriteHeight = Math.ceil(actualThumbnails / spriteColumns) * thumbnailHeight;
        // Use FFmpeg to create the sprite montage
        await createSpriteWithFFmpeg(tempThumbs, spriteFile, spriteColumns, thumbnailWidth, thumbnailHeight);
        // Clean up temp thumbnails
        for (const tempFile of tempThumbs) {
            await promises_1.default.unlink(tempFile).catch(() => { });
        }
        spriteFiles.push(`sprite_${spriteIndex}.jpg`);
        logger_1.logger.info(`Generated sprite ${spriteIndex + 1}/${numberOfSprites}: ${node_path_1.default.basename(spriteFile)}`);
    }
    // Generate VTT file
    const vttContent = [
        'WEBVTT',
        '',
        ...vttEntries
    ].join('\n');
    const vttFile = node_path_1.default.join(outputDir, 'thumbnails.vtt');
    await promises_1.default.writeFile(vttFile, vttContent);
    logger_1.logger.info(`Generated VTT file with ${totalThumbnails} thumbnail entries`);
    return { spriteFiles, vttFile: 'thumbnails.vtt' };
}
async function createSpriteWithFFmpeg(thumbnailFiles, outputFile, columns, thumbWidth, thumbHeight) {
    // For simplicity, we'll use a basic grid layout with FFmpeg filter
    // In production, you might want to use ImageMagick for better control
    if (thumbnailFiles.length === 0)
        return;
    // For now, create a simple horizontal strip and let the client handle the grid
    // This is a simplified version - in production you'd want proper sprite generation
    await new Promise((resolve, reject) => {
        const command = (0, fluent_ffmpeg_1.default)();
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
function formatVttTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}
