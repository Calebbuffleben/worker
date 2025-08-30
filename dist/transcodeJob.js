"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTranscodeJob = handleTranscodeJob;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const logger_1 = require("./logger");
const r2_1 = require("./r2");
const ffmpeg_1 = require("./ffmpeg");
const mime_1 = __importDefault(require("mime"));
const axios_1 = __importDefault(require("axios"));
async function handleTranscodeJob(job) {
    const data = job.data;
    const segmentSeconds = data.segmentSeconds ?? 6;
    const crf = data.crf ?? 21;
    const preset = data.preset ?? 'veryfast';
    const ladder = data.ladder ?? [
        //  { width: 1920, height: 1080, videoBitrateKbps: 6000, audioBitrateKbps: 128 }, // 1080p
        { width: 1280, height: 720, videoBitrateKbps: 3000, audioBitrateKbps: 128 }, // 720p
        //  { width: 854, height: 480, videoBitrateKbps: 1500, audioBitrateKbps: 128 },   // 480p
        { width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 128 }, // 360p
        //  { width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 128 },    // 240p
    ];
    const hlsPath = data.hlsPath ?? 'hls';
    return (0, ffmpeg_1.withTempDir)(async (tmp) => {
        // 1) Download original to temp file
        const inputPath = node_path_1.default.join(tmp, 'input');
        const srcKey = data.sourcePath; // absolute key in R2
        const readStream = await (0, r2_1.getObjectStream)(srcKey);
        const write = (await Promise.resolve().then(() => __importStar(require('node:fs')))).createWriteStream(inputPath);
        await new Promise((resolve, reject) => {
            readStream.pipe(write);
            readStream.on('error', reject);
            write.on('error', reject);
            write.on('finish', () => resolve());
        });
        // 2) Probe
        const info = await (0, ffmpeg_1.probe)(inputPath);
        logger_1.logger.info({ info }, 'ffprobe info');
        // 3) Transcode to HLS (MVP: single variant)
        const outDir = node_path_1.default.join(tmp, hlsPath);
        const { masterPath } = await (0, ffmpeg_1.transcodeToHls)(inputPath, outDir, {
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
        const relativeDir = node_path_1.default.relative(tmp, outDir);
        await uploadDirectory(outDir, `${data.assetKey}/${relativeDir}`);
        const hlsMasterRelative = node_path_1.default.relative(tmp, masterPath).replace(/\\/g, '/');
        const hlsMasterPath = hlsMasterRelative; // Just the relative path: hls/master.m3u8
        // 5) Advanced thumbnails: Generate sprites and VTT
        const thumbsDir = node_path_1.default.join(tmp, 'thumbs');
        await promises_1.default.mkdir(thumbsDir, { recursive: true });
        try {
            // Generate main thumbnail (first frame)
            const mainThumbPath = node_path_1.default.join(thumbsDir, '0001.jpg');
            await (0, ffmpeg_1.extractThumbnail)(inputPath, mainThumbPath, Math.min(1, Math.max(0, Math.floor((info.durationSeconds || 1) / 10))));
            const thumbBuf = await promises_1.default.readFile(mainThumbPath);
            await (0, r2_1.putObject)(`${data.assetKey}/thumbs/0001.jpg`, thumbBuf, 'image/jpeg');
            // Generate thumbnail sprites for scrubbing
            if (info.durationSeconds > 10) { // Only for videos longer than 10 seconds
                const { spriteFiles, vttFile } = await (0, ffmpeg_1.generateThumbnailSprites)(inputPath, thumbsDir, {
                    durationSeconds: info.durationSeconds,
                    intervalSeconds: Math.max(2, Math.floor(info.durationSeconds / 50)), // ~50 thumbnails max
                    spriteColumns: 10,
                    spriteRows: 10,
                    thumbnailWidth: 160,
                    thumbnailHeight: 90,
                });
                // Upload sprites and VTT
                for (const spriteFile of spriteFiles) {
                    const spritePath = node_path_1.default.join(thumbsDir, spriteFile);
                    const spriteBuffer = await promises_1.default.readFile(spritePath);
                    await (0, r2_1.putObject)(`${data.assetKey}/thumbs/${spriteFile}`, spriteBuffer, 'image/jpeg');
                }
                // Upload VTT file
                const vttPath = node_path_1.default.join(thumbsDir, vttFile);
                const vttBuffer = await promises_1.default.readFile(vttPath);
                await (0, r2_1.putObject)(`${data.assetKey}/thumbs/${vttFile}`, vttBuffer, 'text/vtt');
                logger_1.logger.info(`Uploaded ${spriteFiles.length} sprite files and VTT`);
            }
        }
        catch (thumbError) {
            logger_1.logger.warn({ thumbError }, 'Failed to generate thumbnails, continuing...');
        }
        const result = {
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
                await axios_1.default.post(url, {
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
                logger_1.logger.info({ videoId: result.videoId }, 'Callback to backend succeeded');
            }
            catch (cbErr) {
                logger_1.logger.error({ err: cbErr }, 'Callback to backend failed');
            }
        }
        else {
            logger_1.logger.warn('BACKEND_API_URL not set; skipping callback');
        }
        return result;
    });
}
async function uploadDirectory(localDir, destPrefix) {
    const entries = await promises_1.default.readdir(localDir, { withFileTypes: true });
    for (const e of entries) {
        const full = node_path_1.default.join(localDir, e.name);
        const key = `${destPrefix}/${e.name}`.replace(/\\/g, '/');
        if (e.isDirectory()) {
            await uploadDirectory(full, key);
        }
        else {
            const buf = await promises_1.default.readFile(full);
            const contentType = mime_1.default.getType(e.name) || undefined;
            await (0, r2_1.putObject)(key, buf, contentType);
        }
    }
}
