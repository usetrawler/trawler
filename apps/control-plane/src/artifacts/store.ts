import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ArtifactStorage {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

export interface ArtifactStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  remove(key: string): Promise<void>;
}

export function s3Store(storage: ArtifactStorage, timeouts: { connectionMs?: number; requestMs?: number } = {}): ArtifactStore {
  const client = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    forcePathStyle: storage.pathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    requestHandler: { connectionTimeout: timeouts.connectionMs ?? 5_000, requestTimeout: timeouts.requestMs ?? 30_000, throwOnRequestTimeout: true },
  });
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async read(key) {
      try {
        const { Body } = await client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
        return Body ? Body.transformToWebStream() : null;
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })).catch((err: unknown) => {
        if ((err as { name?: string }).name !== "NoSuchKey") throw err;
      });
    },
  };
}
