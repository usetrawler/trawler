import { z } from "zod";

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_JOB = 50;

export const ARTIFACT_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type ArtifactContentType = keyof typeof ARTIFACT_EXTENSIONS;

export const isArtifactContentType = (type: string): type is ArtifactContentType => Object.hasOwn(ARTIFACT_EXTENSIONS, type);

export const ArtifactUploadSchema = z.object({
  kind: z.enum(["screenshot"]),
  finding: z.string().min(1).max(100).optional(),
});
export type ArtifactUpload = z.infer<typeof ArtifactUploadSchema>;

export const ArtifactStoredSchema = z.object({ id: z.string().uuid() });
