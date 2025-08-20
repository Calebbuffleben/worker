import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, CompletedPart, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { env } from './env';

export const s3 = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

export async function putObject(key: string, body: Buffer | Uint8Array | Blob | string, contentType?: string) {
  await s3.send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    Body: body as any,
    ContentType: contentType,
  }));
}

export async function getObjectStream(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  return res.Body as unknown as NodeJS.ReadableStream;
}

export async function list(prefix: string) {
  return s3.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: prefix }));
}

export async function listBuckets() {
  return s3.send(new ListBucketsCommand({}));
}

export async function multipartUpload(key: string, parts: Array<{ Body: Buffer | Uint8Array | Blob | string; PartNumber: number }>, contentType?: string) {
  const create = await s3.send(new CreateMultipartUploadCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType,
  }));

  const uploadedParts: CompletedPart[] = [];
  for (const part of parts) {
    const res = await s3.send(new UploadPartCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      UploadId: create.UploadId!,
      PartNumber: part.PartNumber,
      Body: part.Body as any,
    }));
    uploadedParts.push({ ETag: res.ETag!, PartNumber: part.PartNumber });
  }

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    UploadId: create.UploadId!,
    MultipartUpload: { Parts: uploadedParts },
  }));
}


