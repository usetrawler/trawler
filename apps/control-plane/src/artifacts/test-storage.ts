import { randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { ArtifactStorage } from "./store.ts";

const TEST_S3 = { endpoint: "http://127.0.0.1:54339", region: "us-east-1", accessKeyId: "trawler", secretAccessKey: "trawler-s3-secret", pathStyle: true };

export async function testStorage(): Promise<ArtifactStorage> {
  const storage = { ...TEST_S3, bucket: `trawler-test-${randomUUID().slice(0, 12)}` };
  const client = new S3Client({ region: storage.region, endpoint: storage.endpoint, forcePathStyle: true, credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
  try {
    await client.send(new CreateBucketCommand({ Bucket: storage.bucket }));
  } catch (err) {
    throw new Error(`the test S3 server at 127.0.0.1:54339 is not reachable (${err instanceof Error ? err.message : String(err)}); run \`npm run db:up\``);
  } finally {
    client.destroy();
  }
  return storage;
}
