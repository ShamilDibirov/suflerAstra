import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from './config';
const s3 = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: process.env.S3_ACCESS_KEY
    ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY || '' }
    : undefined,
});
const memory = new Map<string, { body: Buffer; type: string }>();
export async function putFile(key: string, body: Buffer, type: string) {
  if (config.demo) {
    memory.set(key, { body, type });
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: type,
      ServerSideEncryption: process.env.S3_SSE === 'AES256' ? 'AES256' : undefined,
    }),
  );
}
export async function getFile(key: string) {
  if (config.demo) {
    const data = memory.get(key);
    if (!data) throw new Error('Файл не найден');
    return data;
  }
  const r = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  return {
    body: Buffer.from(await r.Body!.transformToByteArray()),
    type: r.ContentType || 'application/octet-stream',
  };
}
export async function deleteFile(key: string) {
  if (config.demo) {
    memory.delete(key);
    return;
  }
  await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
