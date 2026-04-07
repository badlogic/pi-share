import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { downloadFile, uploadFiles } from "@huggingface/hub";
import type { RepoDesignation } from "@huggingface/hub";

function datasetRepo(repo: string): RepoDesignation {
  return { type: "dataset", name: repo };
}

export function readHfAccessToken(): string | undefined {
  const envToken = process.env.HF_TOKEN?.trim();
  if (envToken) return envToken;

  const fallbackEnvToken = process.env.HUGGINGFACE_TOKEN?.trim();
  if (fallbackEnvToken) return fallbackEnvToken;

  const tokenFiles = [
    path.join(os.homedir(), ".cache", "huggingface", "token"),
    path.join(os.homedir(), ".huggingface", "token"),
  ];

  for (const file of tokenFiles) {
    if (!fs.existsSync(file)) continue;
    const token = fs.readFileSync(file, "utf-8").trim();
    if (token) return token;
  }

  return undefined;
}

export function requireHfAccessToken(): string {
  const token = readHfAccessToken();
  if (token) return token;
  throw new Error([
    "Missing Hugging Face access token.",
    "Set HF_TOKEN in your environment, or write the token to ~/.cache/huggingface/token.",
    "The token needs write access to the target dataset repo.",
  ].join("\n"));
}

export async function downloadDatasetTextFile(repo: string, filePath: string): Promise<string | undefined> {
  try {
    const blob = await downloadFile({
      repo: datasetRepo(repo),
      path: filePath,
      accessToken: readHfAccessToken(),
    });
    if (!blob) return undefined;
    return await blob.text();
  } catch {
    return undefined;
  }
}

export async function uploadDatasetFolder(repo: string, localDir: string, commitTitle: string): Promise<void> {
  const files = fs.readdirSync(localDir).map((name) => ({
    path: name,
    content: new Blob([fs.readFileSync(path.join(localDir, name))]),
  }));
  await uploadFiles({
    repo: datasetRepo(repo),
    accessToken: requireHfAccessToken(),
    files,
    commitTitle,
  });
}
