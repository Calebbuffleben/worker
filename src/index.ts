import { startWorker } from './queue';
import { logger } from './logger';
import { env } from './env';

async function main() {
  logger.info({ queue: env.QUEUE_NAME, redis: env.REDIS_URL }, 'Starting FFmpeg worker');
  startWorker();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


