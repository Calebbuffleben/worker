"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const queue_1 = require("./queue");
const logger_1 = require("./logger");
const env_1 = require("./env");
async function main() {
    logger_1.logger.info({ queue: env_1.env.QUEUE_NAME, redis: env_1.env.REDIS_URL }, 'Starting FFmpeg worker');
    (0, queue_1.startWorker)();
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
