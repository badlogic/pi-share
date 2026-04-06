import fs from "node:fs";
import type { SessionReviewFile } from "./types.ts";
import { REVIEW_CHUNK_CHAR_LIMIT, REVIEW_PROMPT_VERSION } from "./types.ts";
import { isRecord, sha256File, sha256Text } from "./workspace.ts";

export function loadReviewFile(filePath: string): SessionReviewFile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.file !== "string") return undefined;
    if (!isRecord(parsed.aggregate)) return undefined;
    return parsed as unknown as SessionReviewFile;
  } catch {
    return undefined;
  }
}

export async function hashContextFiles(files: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = await sha256File(file);
  return hashes;
}

export function computeDenyHash(patterns: RegExp[]): string {
  const data = patterns
    .map((pattern) => `${pattern.source}/${pattern.flags}`)
    .sort()
    .join("\n");
  return sha256Text(data);
}

export function computeReviewKey(
  redactedHash: string,
  contextHashes: Record<string, string>,
  provider?: string,
  model?: string,
  thinking?: string,
  denyHash?: string,
): string {
  return sha256Text(JSON.stringify({
    redactedHash,
    contextHashes,
    provider,
    model,
    thinking,
    denyHash,
    promptVersion: REVIEW_PROMPT_VERSION,
    chunkCharLimit: REVIEW_CHUNK_CHAR_LIMIT,
  }));
}
