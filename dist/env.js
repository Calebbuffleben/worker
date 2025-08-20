"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const schema = zod_1.z.object({
    R2_ACCESS_KEY_ID: zod_1.z.string().min(1),
    R2_SECRET_ACCESS_KEY: zod_1.z.string().min(1),
    R2_ACCOUNT_ID: zod_1.z.string().min(1),
    R2_BUCKET: zod_1.z.string().min(1),
    R2_ENDPOINT: zod_1.z.string().url(),
    REDIS_URL: zod_1.z.string().min(1),
    QUEUE_NAME: zod_1.z.string().default('video-transcode'),
    // Optional callback to backend to mark status, if desired
    BACKEND_API_URL: zod_1.z.string().url().optional(),
    BACKEND_API_TOKEN: zod_1.z.string().optional(),
});
exports.env = schema.parse(process.env);
