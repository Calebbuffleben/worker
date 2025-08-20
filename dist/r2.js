"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.s3 = void 0;
exports.putObject = putObject;
exports.getObjectStream = getObjectStream;
exports.list = list;
exports.listBuckets = listBuckets;
exports.multipartUpload = multipartUpload;
const client_s3_1 = require("@aws-sdk/client-s3");
const env_1 = require("./env");
exports.s3 = new client_s3_1.S3Client({
    region: 'auto',
    endpoint: env_1.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: env_1.env.R2_ACCESS_KEY_ID,
        secretAccessKey: env_1.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});
async function putObject(key, body, contentType) {
    await exports.s3.send(new client_s3_1.PutObjectCommand({
        Bucket: env_1.env.R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
    }));
}
async function getObjectStream(key) {
    const res = await exports.s3.send(new client_s3_1.GetObjectCommand({ Bucket: env_1.env.R2_BUCKET, Key: key }));
    return res.Body;
}
async function list(prefix) {
    return exports.s3.send(new client_s3_1.ListObjectsV2Command({ Bucket: env_1.env.R2_BUCKET, Prefix: prefix }));
}
async function listBuckets() {
    return exports.s3.send(new client_s3_1.ListBucketsCommand({}));
}
async function multipartUpload(key, parts, contentType) {
    const create = await exports.s3.send(new client_s3_1.CreateMultipartUploadCommand({
        Bucket: env_1.env.R2_BUCKET,
        Key: key,
        ContentType: contentType,
    }));
    const uploadedParts = [];
    for (const part of parts) {
        const res = await exports.s3.send(new client_s3_1.UploadPartCommand({
            Bucket: env_1.env.R2_BUCKET,
            Key: key,
            UploadId: create.UploadId,
            PartNumber: part.PartNumber,
            Body: part.Body,
        }));
        uploadedParts.push({ ETag: res.ETag, PartNumber: part.PartNumber });
    }
    await exports.s3.send(new client_s3_1.CompleteMultipartUploadCommand({
        Bucket: env_1.env.R2_BUCKET,
        Key: key,
        UploadId: create.UploadId,
        MultipartUpload: { Parts: uploadedParts },
    }));
}
