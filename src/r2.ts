import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, CompletedPart, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, ListBucketsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env';

// Criar o cliente do S3
export const s3 = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

// Função que faz o upload de um objeto para o R2
// key é a chave do objeto
// body é o corpo do objeto
// contentType é o tipo de conteúdo do objeto
// Isso é usado para enviar o vídeo transcodado e a thumbnail para o R2
export async function putObject(key: string, body: Buffer | Uint8Array | Blob | string, contentType?: string) {
  await s3.send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    Body: body as any,
    ContentType: contentType,
  }));
}

// Função que faz o download de um objeto para o R2
// key é a chave do objeto
// Isso é usado para baixar o vídeo transcodado e a thumbnail do R2
export async function getObjectStream(key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  return res.Body as unknown as NodeJS.ReadableStream;
}

// Função que lista os objetos do R2
// prefix é o prefixo dos objetos
// Isso é usado para listar os objetos do R2
export async function list(prefix: string) {
  return s3.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: prefix }));
}

// Função que lista os buckets do R2
// Isso é usado para listar os buckets do R2
export async function listBuckets() {
  return s3.send(new ListBucketsCommand({}));
}

// Função que faz o upload de um objeto para o R2
// key é a chave do objeto
// parts é o array de partes do objeto
// contentType é o tipo de conteúdo do objeto
// Isso é usado para enviar o vídeo transcodado e a thumbnail para o R2
// A difenrença para o putObject é que o multipartUpload é usado 
// para enviar objetos grandes e o putObject é usado para enviar objetos pequenos
export async function multipartUpload(key: string, parts: Array<{ Body: Buffer | Uint8Array | Blob | string; PartNumber: number }>, contentType?: string) {
  const create = await s3.send(new CreateMultipartUploadCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType,
  }));
  // Inicializar o array de partes enviadas
  const uploadedParts: CompletedPart[] = [];
  for (const part of parts) {
    // Fazer o upload de uma parte do objeto
    const res = await s3.send(new UploadPartCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      UploadId: create.UploadId!,
      PartNumber: part.PartNumber,
      Body: part.Body as any,
    }));
    // Adicionar a parte enviada ao array de partes enviadas
    uploadedParts.push({ ETag: res.ETag!, PartNumber: part.PartNumber });
  }

  // Completar o upload do objeto
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    UploadId: create.UploadId!,
    MultipartUpload: { Parts: uploadedParts },
  }));
}

// Função que faz a remoção de um objeto do R2
// key é a chave do objeto
// Isso é usado para remover o vídeo transcodado e a thumbnail do R2
export async function removeObject(key: string) {
  await s3.send(new DeleteObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
  }));
}


