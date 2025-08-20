import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT: z.string().url(),

  REDIS_URL: z.string().min(1),
  QUEUE_NAME: z.string().default('video-transcode'),

  // Optional callback to backend to mark status, if desired
  BACKEND_API_URL: z.string().url().optional(),
  BACKEND_API_TOKEN: z.string().optional(),
});

export const env = schema.parse(process.env);


