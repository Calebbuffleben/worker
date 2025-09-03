import cluster from 'node:cluster';
import os from 'node:os';
import process from 'node:process';
import { startWorker } from './queue';
import { logger } from './logger';
import { env } from './env';

async function startSingleWorker() {
  logger.info({ queue: env.QUEUE_NAME, redis: env.REDIS_URL, concurrency: process.env.WORKER_CONCURRENCY || 1 }, 'Starting FFmpeg worker');
  const worker = startWorker();

  const shutdown = async (signal: string) => {
    try {
      logger.info({ signal, pid: process.pid }, 'Shutting down worker');
      await worker.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function main() {
  const enableCluster = String(process.env.WORKER_CLUSTER || '').toLowerCase() === 'true';
  const cpuCount = os.cpus().length;
  const desiredWorkers = Math.max(1, Number(process.env.WORKER_COUNT || cpuCount));

  if (enableCluster && cluster.isPrimary) {
    logger.info({ desiredWorkers, cpuCount }, 'Starting worker cluster');

    for (let i = 0; i < desiredWorkers; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.warn({ pid: worker.process.pid, code, signal }, 'Worker process exited - forking replacement');
      cluster.fork();
    });
  } else {
    await startSingleWorker();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


