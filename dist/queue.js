"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueEvents = exports.queue = void 0;
exports.startWorker = startWorker;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("./env");
const logger_1 = require("./logger");
const transcodeJob_1 = require("./transcodeJob");
const connection = new ioredis_1.default(env_1.env.REDIS_URL, { maxRetriesPerRequest: null });
exports.queue = new bullmq_1.Queue(env_1.env.QUEUE_NAME, { connection });
exports.queueEvents = new bullmq_1.QueueEvents(env_1.env.QUEUE_NAME, { connection });
function startWorker() {
    const worker = new bullmq_1.Worker(env_1.env.QUEUE_NAME, async (job) => {
        logger_1.logger.info({ jobId: job.id, data: job.data }, 'Worker received job');
        return (0, transcodeJob_1.handleTranscodeJob)(job);
    }, { connection, concurrency: Number(process.env.WORKER_CONCURRENCY || 1) });
    worker.on('completed', (job, result) => {
        logger_1.logger.info({ jobId: job.id, result }, 'Job completed');
    });
    worker.on('failed', (job, err) => {
        logger_1.logger.error({ jobId: job?.id, err }, 'Job failed');
    });
    exports.queueEvents.on('waiting', ({ jobId }) => logger_1.logger.info({ jobId }, 'Job waiting'));
    exports.queueEvents.on('active', ({ jobId }) => logger_1.logger.info({ jobId }, 'Job active'));
    exports.queueEvents.on('completed', ({ jobId }) => logger_1.logger.info({ jobId }, 'Job completed event'));
    exports.queueEvents.on('failed', ({ jobId, failedReason }) => logger_1.logger.error({ jobId, failedReason }, 'Job failed event'));
    return worker;
}
