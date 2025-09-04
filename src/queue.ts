import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from './logger';
import { TranscodeJobData, TranscodeJobResult } from './types';
import { handleTranscodeJob } from './transcodeJob';

// Criar a conexão com o Redis
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

// Criar a fila
export const queue = new Queue<TranscodeJobData>(env.QUEUE_NAME, { connection });
// Criar os eventos da fila
export const queueEvents = new QueueEvents(env.QUEUE_NAME, { connection });

// Criar o worker
export function startWorker() {
  // Obter o número de workers
  const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY || '1'));
  // Logar o número de workers
  logger.info({ concurrency, pid: process.pid }, 'Initializing BullMQ worker');

  // Criar o worker
  const worker = new Worker<TranscodeJobData, TranscodeJobResult>(
    env.QUEUE_NAME,
    async (job: Job<TranscodeJobData>) => {
      // Logar o job recebido
      logger.info({ jobId: job.id, data: job.data }, 'Worker received job');
      // HandleTranscodeJob é a função que trata o job de transcodificação
      // Ela é responsável por:
      // 1) Download do vídeo original
      // 2) Probe do vídeo original
      // 3) Transcodificação do vídeo para HLS
      // 4) Upload do vídeo transcodado para o R2
      // 5) Upload da thumbnail para o R2
      // 6) Callback para o backend
      // 7) Rollback em caso de falha
      return handleTranscodeJob(job);
    },
    // Criar o worker
    { connection, concurrency }
  );
  // Criar o evento de completado
  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'Job completed');
  });
  // Criar o evento de falha
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Job failed');
  });
  // Criar o evento de erro
  worker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  // Criar o evento de waiting
  queueEvents.on('waiting', ({ jobId }) => logger.info({ jobId }, 'Job waiting'));
  // Criar o evento de active
  queueEvents.on('active', ({ jobId }) => logger.info({ jobId }, 'Job active'));
  // Criar o evento de completed
  queueEvents.on('completed', ({ jobId }) => logger.info({ jobId }, 'Job completed event'));
  // Criar o evento de failed
  queueEvents.on('failed', ({ jobId, failedReason }) => logger.error({ jobId, failedReason }, 'Job failed event'));

  // Retornar o worker
  return worker;
}


