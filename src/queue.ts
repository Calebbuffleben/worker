import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from './logger';
import { TranscodeJobData, TranscodeJobResult } from './types';
import { handleTranscodeJob } from './transcodeJob';

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const queue = new Queue<TranscodeJobData>(env.QUEUE_NAME, { connection });
export const queueEvents = new QueueEvents(env.QUEUE_NAME, { connection });

export function startWorker() {
  const worker = new Worker<TranscodeJobData, TranscodeJobResult>(
    env.QUEUE_NAME,
    async (job: Job<TranscodeJobData>) => {
      logger.info({ jobId: job.id, data: job.data }, 'Worker received job');
      return handleTranscodeJob(job);
    },
    { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 1) }
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'Job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Job failed');
  });

  queueEvents.on('waiting', ({ jobId }) => logger.info({ jobId }, 'Job waiting'));
  queueEvents.on('active', ({ jobId }) => logger.info({ jobId }, 'Job active'));
  queueEvents.on('completed', ({ jobId }) => logger.info({ jobId }, 'Job completed event'));
  queueEvents.on('failed', ({ jobId, failedReason }) => logger.error({ jobId, failedReason }, 'Job failed event'));

  return worker;
}


