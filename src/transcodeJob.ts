import fs from 'node:fs/promises';
import path from 'node:path';
import { Job } from 'bullmq';
import { logger } from './logger';
import { TranscodeJobData, TranscodeJobResult } from './types';
import { getObjectStream, putObject, removeObject } from './r2';
import { probe, transcodeToHls, withTempDir, extractThumbnail, generateThumbnailSprites } from './ffmpeg';
import mime from 'mime';
import axios from 'axios';

// Função que trata o job de transcodificação
export async function handleTranscodeJob(job: Job<TranscodeJobData>): Promise<TranscodeJobResult> {
  // Obter os dados do job
  const data = job.data;
  // Obter o tempo de início do job
  const startTime = Date.now();
  
  // Ajustar segmentSeconds baseado na duração do vídeo
  let segmentSeconds = data.segmentSeconds ?? 6;
  
  // Obter os valores dos parâmetros de transcodificação
  const crf = data.crf ?? 21;
  const preset = data.preset ?? 'superfast';
  const ladder = data.ladder ?? [
  //  { width: 1920, height: 1080, videoBitrateKbps: 6000, audioBitrateKbps: 128 }, // 1080p
    { width: 1280, height: 720, videoBitrateKbps: 3000, audioBitrateKbps: 128 },  // 720p
  //  { width: 854, height: 480, videoBitrateKbps: 1500, audioBitrateKbps: 128 },   // 480p
   // { width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 128 },    // 360p
  //  { width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 128 },    // 240p
  ];
  const hlsPath = data.hlsPath ?? 'hls';

  // Retornar uma promise que resolve com o resultado do job
  return withTempDir(async (tmp) => {
    // 1) Download original to temp file

    // Iniciar o download do original
    const downloadStart = Date.now();
    // Criar o caminho do arquivo de entrada
    const inputPath = path.join(tmp, 'input');
    // Obter o caminho do arquivo de entrada
    const srcKey = data.sourcePath; // absolute key in R2
    // Obter o stream do arquivo de entrada
    const readStream = await getObjectStream(srcKey);
    // Criar o stream de escrita
    const write = (await import('node:fs')).createWriteStream(inputPath);
    // Aguardar o download do original
    await new Promise<void>((resolve, reject) => {
      readStream.pipe(write);
      readStream.on('error', reject);
      write.on('error', reject);
      write.on('finish', () => resolve());
    });
    // Obter o tempo de fim do download
    const downloadEnd = Date.now();
    // Obter o tempo de duração do download
    const downloadDuration = downloadEnd - downloadStart;
    
    // Obter o tamanho do arquivo de entrada
    const inputStats = await fs.stat(inputPath);
    // Obter o tamanho do arquivo de entrada em MB
    const inputSizeMB = inputStats.size / (1024 * 1024);
    // Obter a taxa de download
    const downloadThroughput = inputSizeMB / (downloadDuration / 1000);
    
    logger.info({ 
      phase: 'download', 
      duration: downloadDuration, 
      sizeMB: inputSizeMB.toFixed(2),
      throughput: downloadThroughput.toFixed(2)
    }, 'Download completed');

    // 2)
    // Probe é uma função que usa o ffmpeg para obter informações sobre o vídeo
    // Ela retorna um objeto com as informações do vídeo
    // Essas informações são usadas para ajustar os parâmetros de transcodificação
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
    const transcodeStart = Date.now();
    // Criar o caminho do diretório de saída
    const outDir = path.join(tmp, hlsPath);
    const { masterPath } = await transcodeToHls(inputPath, outDir, {
      variants: ladder.map(x => ({
        // Criar o objeto com as informações da variante
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
    // Obter o tempo de fim da transcodificação
    const transcodeEnd = Date.now();
    // Obter o tempo de duração da transcodificação
    const transcodeDuration = transcodeEnd - transcodeStart;
    
    // Logar o resultado da transcodificação
    logger.info({ 
      phase: 'transcode', 
      duration: transcodeDuration,
      variants: ladder.length,
      segmentSeconds,
      preset,
      crf
    }, 'Transcode completed');

    // 4) Upload HLS outputs to R2 under assetKey/hls
    const uploadStart = Date.now();
    // Obter o diretório relativo
    const relativeDir = path.relative(tmp, outDir);
    // Uploadar o diretório de saída para o R2
    const uploadResult = await uploadDirectory(outDir, `${data.assetKey}/${relativeDir}`);
    // Obter o tempo de fim da upload
    const uploadEnd = Date.now();
    // Obter o tempo de duração da upload
    const uploadDuration = uploadEnd - uploadStart;
    
    // Calculate upload throughput
    const uploadSizeMB = uploadResult.totalBytes / (1024 * 1024);
    const uploadThroughput = uploadSizeMB / (uploadDuration / 1000);
    
    logger.info({ 
      phase: 'upload', 
      duration: uploadDuration,
      sizeMB: uploadSizeMB.toFixed(2),
      throughput: uploadThroughput.toFixed(2),
      files: uploadResult.fileCount
    }, 'Upload completed');

    const hlsMasterRelative = path.relative(tmp, masterPath).replace(/\\/g, '/');
    const hlsMasterPath = hlsMasterRelative; // Just the relative path: hls/master.m3u8

    // 5) Thumbnail única para capa
    const thumbsDir = path.join(tmp, 'thumbs');
    // Criar o diretório de saída
    await fs.mkdir(thumbsDir, { recursive: true });
    try {
      // Criar o caminho do arquivo de saída
      const mainThumbPath = path.join(thumbsDir, '0001.jpg');
      // Obter o segundo médio
      const midSecond = Math.max(1, Math.floor((info.durationSeconds || 2) / 2));
      // Extrair a thumbnail
      await extractThumbnail(inputPath, mainThumbPath, midSecond, 1280);
      // Obter o buffer da thumbnail
      const thumbBuf = await fs.readFile(mainThumbPath);
      // Uploadar a thumbnail para o R2
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
      // Obter o número máximo de tentativas de callback
      const maxCallbackRetries = 10;
      // Criar o callbackSuccess
      let callbackSuccess = false;
    
      // Normalizar a base para que contenha exatamente uma "/api"
      const base = process.env.BACKEND_API_URL
        .replace(/\/$/, '')
        .replace(/\/api\/api$/, '/api')
        .replace(/([^/])$/, '$1');
      // Criar o ensuredApi
      const ensuredApi = base.endsWith('/api') ? base : `${base}/api`;

      // Criar o loop de tentativas
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
            timeout: 120000, // Increased from 30s to 120s (2 minutes)
          });
          
          logger.info({ videoId: result.videoId, attempt }, 'Callback to backend succeeded');
          // Definir o callbackSuccess como true para sair do loop 
          callbackSuccess = true;
        } catch (cbErr) {
          // Se o número de tentativas for igual ao número máximo de tentativas 
          // e o callbackSuccess for false, então iniciar o rollback
          if (attempt === maxCallbackRetries) {
            logger.error({ 
              err: cbErr, 
              attempt, 
              videoId: result.videoId, 
              jobId: job.id,
              maxRetries: maxCallbackRetries,
              errorDetails: cbErr instanceof Error ? cbErr.message : String(cbErr)
            }, 'Callback to backend failed after all retries - starting rollback');
            
            // ROLLBACK COMPLETO: Remover vídeo do R2 e notificar falha
            try {
              logger.warn({ 
                videoId: result.videoId, 
                jobId: job.id,
                assetKey: data.assetKey 
              }, 'Starting complete rollback - removing video from R2');
              
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
                error: `Callback failed after ${maxCallbackRetries} attempts - video removed from R2. Job ID: ${job.id}`,
                timestamp: new Date().toISOString(),
                jobId: job.id, // Incluir jobId para rastreabilidade
              }, {
                headers: process.env.BACKEND_API_TOKEN ? { Authorization: `Bearer ${process.env.BACKEND_API_TOKEN}` } : undefined,
                timeout: 120000, // Increased from 30s to 120s (2 minutes)
              });
              
              logger.info({ 
                videoId: result.videoId, 
                jobId: job.id,
                assetKey: data.assetKey,
                rollbackCompleted: true
              }, 'Rollback completed - failure notified to backend');
            } catch (rollbackErr) {
              logger.error({ 
                err: rollbackErr, 
                videoId: result.videoId, 
                jobId: job.id,
                assetKey: data.assetKey,
                rollbackFailed: true
              }, 'Rollback failed - manual intervention required');
            }
            
            // FALHAR O JOB para triggerar retry automático do BullMQ
            throw new Error(`Callback failed after ${maxCallbackRetries} attempts - video rolled back from R2`);
          } else {
            const retryDelay = 2000 * Math.pow(2, attempt - 1);
            logger.warn({ 
              err: cbErr, 
              attempt, 
              videoId: result.videoId, 
              jobId: job.id,
              maxRetries: maxCallbackRetries,
              retryDelay,
              nextRetryIn: `${retryDelay}ms`
            }, `Callback to backend failed, retrying... (${attempt}/${maxCallbackRetries})`);
            
            // Wait before retry (exponential backoff: 2s, 4s, 8s, 16s, 32s)
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
      }
    } else {
      logger.warn('BACKEND_API_URL not set; skipping callback');
    }

    // Final performance summary
    const totalDuration = Date.now() - startTime;
    const totalSizeMB = (inputSizeMB + uploadSizeMB).toFixed(2);
    const totalThroughput = (parseFloat(totalSizeMB) / (totalDuration / 1000)).toFixed(2);
    
    logger.info({
      phase: 'summary',
      videoId: data.videoId,
      totalDuration,
      totalSizeMB,
      totalThroughput,
      breakdown: {
        download: { duration: downloadDuration, sizeMB: inputSizeMB.toFixed(2), throughput: downloadThroughput.toFixed(2) },
        transcode: { duration: transcodeDuration },
        upload: { duration: uploadDuration, sizeMB: uploadSizeMB.toFixed(2), throughput: uploadThroughput.toFixed(2) }
      }
    }, 'Job completed - Performance summary');

    return result;
  });
}

// Função que faz o upload de um diretório para o R2
// Isso quer dzer que vamos usar o r2 para armazenar o vídeo transcodado
// e as thumbnails
async function uploadDirectory(localDir: string, destPrefix: string): Promise<{ totalBytes: number; fileCount: number }> {
  // Obter os arquivos do diretório
  const entries = await fs.readdir(localDir, { withFileTypes: true });

  // Inicializar o total de bytes
  let totalBytes = 0;
  // Inicializar o total de arquivos
  let fileCount = 0;

  // Split into directories and files to preserve structure
  const directories: Array<{ full: string; key: string }> = [];
  
  // Inicializar o array de arquivos
  const files: Array<{ full: string; key: string; name: string }> = [];

  // Loop pelos arquivos do diretório
  for (const e of entries) {
    // Criar o caminho completo do arquivo
    const full = path.join(localDir, e.name);
    // Criar a chave do arquivo
    const key = `${destPrefix}/${e.name}`.replace(/\\/g, '/');
    // Se o arquivo for um diretório, adicionar ao array de diretórios
    if (e.isDirectory()) {
      // Adicionar ao array de diretórios
      directories.push({ full, key });
    } else {
      // Adicionar ao array de arquivos
      files.push({ full, key, name: e.name });
    }
  }
  // Subir os diretórios primeiro (sequencial) para garantir a hierarquia
  // existe
  for (const dir of directories) {
    // Subir o diretório
    const sub = await uploadDirectory(dir.full, dir.key);
    // Adicionar ao total de bytes
    totalBytes += sub.totalBytes;
    // Adicionar ao total de arquivos
    fileCount += sub.fileCount;
  }

  // Upload arquivos com concorrência limitada
  // Inicializar o máximo de concorrência
  const maxConcurrent = Math.max(1, Math.min(64, parseInt(process.env.MAX_CONCURRENT_UPLOADS || '64', 10)));
  // Inicializar o índice
  let nextIndex = 0;

  // Função que faz o upload de um arquivo
  const uploadWorker = async () => {
    // O loop vai continuar até que o índice seja maior que o total de arquivos
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Obter o índice atual
      const current = nextIndex++;
      // Se o índice atual for maior que o total de arquivos, sair do loop
      if (current >= files.length) break;
      // Obter o arquivo atual
      const f = files[current];
      // Obter o buffer do arquivo
      const buf = await fs.readFile(f.full);
      // Obter o tipo de conteúdo do arquivo
      const contentType = mime.getType(f.name) || undefined;
      // Uploadar o arquivo
      await putObject(f.key, buf, contentType);
      // Adicionar ao total de bytes
      totalBytes += buf.length;
      // Adicionar ao total de arquivos
      fileCount += 1;
    }
  };

  // Inicializar o array de workers
  const workers: Promise<void>[] = [];
  // Obter o número de workers
  const workerCount = Math.min(maxConcurrent, files.length);
  // Loop pelos workers
  for (let i = 0; i < workerCount; i++) workers.push(uploadWorker());
  // Se o número de workers for maior que 0, esperar todos os workers
  if (workers.length > 0) {
    // Aguardar todos os workers
    await Promise.all(workers);
  }
  // Retornar o total de bytes e o total de arquivos
  return { totalBytes, fileCount };
}

// Em resumo esse arquivo é responsável por:
// 1) Download do vídeo original
// 2) Probe do vídeo original que é usado para ajustar os parâmetros de transcodificação (fps, audio channels, etc)
// 3) Transcodificação do vídeo para HLS
// 4) Upload do vídeo transcodado para o R2
// 5) Upload da thumbnail para o R2
// 6) Callback para o backend
// 7) Rollback em caso de falha
