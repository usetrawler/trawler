import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  link(key: string): Promise<string>;
  remove(key: string): Promise<void>;
}

export const LINK_SECONDS = 300;

export function s3Store(storage: ArtifactStorage, timeouts: { connectionMs?: number; requestMs?: number } = {}): ArtifactStore {
  const client = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint,
    forcePathStyle: storage.pathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: timeouts.connectionMs ?? 5_000, requestTimeout: timeouts.requestMs ?? 30_000, throwOnRequestTimeout: true },
  });
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    link(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), { expiresIn: LINK_SECONDS });
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    },
  };
}
