import fs from "node:fs";
import path from "node:path";
import { bold, cyan, green, red, yellow } from "./colors.ts";
import type { ChunkReviewResult, RemoteManifestEntry, UploadOptions } from "./types.ts";
import { REJECT_FILE, REMOTE_MANIFEST_CACHE_FILE, REMOTE_MANIFEST_FILE } from "./types.ts";
import { runCommand, runCommandPassthrough } from "./process.ts";
import { loadReviewFile } from "./review-state.ts";
import { downloadRemoteManifest, loadLocalManifest, readWorkspaceConfig, workspacePath } from "./workspace.ts";

function loadRejectSet(workspace: string): Set<string> {
  const file = workspacePath(workspace, REJECT_FILE);
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean));
}

export async function runUpload(options: UploadOptions): Promise<void> {
  const config = readWorkspaceConfig(options.workspace);
  const repo = config.repo;

  const localManifest = loadLocalManifest(workspacePath(options.workspace, "manifest.local.jsonl"));
  if (localManifest.size === 0) {
    console.log(`No local manifest entries found in ${workspacePath(options.workspace, "manifest.local.jsonl")}`);
    return;
  }

  const rejectedByUser = loadRejectSet(options.workspace);
  const entries = [...localManifest.values()].sort((a, b) => a.file.localeCompare(b.file));
  let approved = 0;
  let rejected = 0;
  let rejectedManual = 0;
  let noReview = 0;
  let missingLocal = 0;
  let unchanged = 0;

  const remoteManifestPath = workspacePath(options.workspace, REMOTE_MANIFEST_CACHE_FILE);
  const remoteManifest = await downloadRemoteManifest(repo, remoteManifestPath);

  for (const entry of entries) {
    const reviewFile = loadReviewFile(workspacePath(options.workspace, "review", `${entry.file}.review.json`));
    const localFile = workspacePath(options.workspace, "redacted", entry.file);

    if (rejectedByUser.has(entry.file)) {
      rejectedManual++;
      continue;
    }

    if (!fs.existsSync(localFile)) {
      missingLocal++;
      continue;
    }
    if (!reviewFile) {
      noReview++;
      continue;
    }
    if (!isUploadApproved(reviewFile.aggregate)) {
      rejected++;
      continue;
    }

    const remoteEntry = remoteManifest.get(entry.file);
    if (remoteEntry?.redacted_hash === entry.redacted_hash) {
      unchanged++;
      continue;
    }

    approved++;
  }

  console.log(`${bold("Total sessions:")} ${cyan(String(entries.length))}`);
  console.log(`${bold("Approved by review:")} ${green(String(approved))}`);
  console.log(`${bold("Rejected by review:")} ${yellow(String(rejected))}`);
  console.log(`${bold("Rejected manually:")} ${yellow(String(rejectedManual))}`);
  console.log(`${bold("No review data:")} ${noReview > 0 ? red(String(noReview)) : String(noReview)}`);
  console.log(`${bold("Already uploaded (unchanged):")} ${unchanged}`);
  console.log(`${bold("Missing local redacted file:")} ${missingLocal}`);

  if (noReview > 0) {
    console.log(`\n${red(`Refusing to upload: ${noReview} session(s) have no review data. Run review first.`)}`);
    return;
  }
  if (options.dryRun) {
    console.log(`\n${yellow("Dry run, not uploading.")}`);
    return;
  }
  if (approved === 0) {
    console.log(`\n${yellow("Nothing to upload.")}`);
    return;
  }

  const uploadDir = workspacePath(options.workspace, "_upload_staging");
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const updatedManifest = new Map(remoteManifest);
  let staged = 0;

  for (const entry of entries) {
    const reviewFile = loadReviewFile(workspacePath(options.workspace, "review", `${entry.file}.review.json`));
    if (rejectedByUser.has(entry.file)) continue;
    if (!reviewFile || !isUploadApproved(reviewFile.aggregate)) continue;

    const remoteEntry = remoteManifest.get(entry.file);
    if (remoteEntry?.redacted_hash === entry.redacted_hash) continue;

    const localFile = workspacePath(options.workspace, "redacted", entry.file);
    if (!fs.existsSync(localFile)) continue;

    fs.copyFileSync(localFile, path.join(uploadDir, entry.file));
    updatedManifest.set(entry.file, {
      file: entry.file,
      source_hash: entry.source_hash,
      redacted_hash: entry.redacted_hash,
    });
    staged++;
  }

  const manifestContents = [...updatedManifest.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  fs.writeFileSync(path.join(uploadDir, REMOTE_MANIFEST_FILE), manifestContents.length > 0 ? `${manifestContents}\n` : "");
  fs.writeFileSync(path.join(uploadDir, "README.md"), await generateDatasetCard(config.cwd, repo, entries.length, approved, rejected + rejectedManual, unchanged));

  console.log(`${bold("Staged for upload:")} ${cyan(String(staged))}`);
  console.log(green("Uploading..."));

  await uploadFolder(repo, uploadDir);

  fs.copyFileSync(path.join(uploadDir, REMOTE_MANIFEST_FILE), workspacePath(options.workspace, REMOTE_MANIFEST_FILE));
  fs.rmSync(uploadDir, { recursive: true, force: true });

  console.log(`${bold("Uploaded:")} ${green(String(staged))}`);
  console.log(`${bold("Updated remote manifest:")} ${REMOTE_MANIFEST_FILE}`);
}

async function generateDatasetCard(
  cwd: string,
  repo: string,
  totalSessions: number,
  approved: number,
  blocked: number,
  unchanged: number,
): Promise<string> {
  const sourceRepo = await resolveGitOrigin(cwd);
  const lines = [
    "---",
    "pretty_name: coding agent session traces",
    "task_categories:",
    "- text-generation",
    "tags:",
    "- agent-traces",
    "- coding-agent",
    "- pi-share-hf",
    "language:",
    "- en",
    "- code",
    "license: other",
    "---",
    "",
    `# Coding agent session traces for ${repo}`,
    "",
    sourceRepo
      ? `This dataset contains redacted coding agent session traces collected while working on ${sourceRepo}. The traces were exported with [pi-share-hf](https://github.com/badlogic/pi-share-hf) from a local [pi](https://pi.dev) workspace and filtered to keep only sessions that passed deterministic redaction and LLM review.`
      : `This dataset contains redacted coding agent session traces exported with [pi-share-hf](https://github.com/badlogic/pi-share-hf) from a local [pi](https://pi.dev) workspace. The traces were filtered to keep only sessions that passed deterministic redaction and LLM review.`,
    "",
    "## Data description",
    "",
    "Each `*.jsonl` file is a redacted pi session. Sessions are stored as JSON Lines files where each line is a structured session entry. Entries include session headers, user and assistant messages, tool results, model changes, thinking level changes, compaction summaries, branch summaries, and custom extension data.",
    "",
    "Pi session files are tree-structured via `id` and `parentId`, so a single session file may contain multiple branches of work. See the upstream session format documentation for the exact schema:",
    "",
    "- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md",
    "",
    sourceRepo ? `Source git repo: ${sourceRepo}` : "Source git repo: (not detected)",
    "",
    "## Redaction and review",
    "",
    "The data was processed with [pi-share-hf](https://github.com/badlogic/pi-share-hf) using deterministic secret redaction plus an LLM review step. Deterministic redaction targets exact known secrets and curated credential patterns. The LLM review decides whether a session is about the OSS project, whether it is fit to share publicly, and whether any sensitive content appears to have been missed.",
    "",
    "Embedded images may be preserved in the uploaded sessions unless the workspace was initialized with `--no-images`.",
    "",
    "## Limitations",
    "",
    "This dataset is best-effort redacted. Coding agent transcripts can still contain sensitive or off-topic content, especially if a session mixed OSS work with unrelated private tasks. Use with appropriate caution.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function resolveGitOrigin(cwd: string): Promise<string | undefined> {
  const inside = await runCommand("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return undefined;
  const origin = await runCommand("git", ["-C", cwd, "remote", "get-url", "origin"]);
  if (!origin.ok) return undefined;
  return origin.stdout.trim() || undefined;
}

function isUploadApproved(result: ChunkReviewResult): boolean {
  if (result.shareable !== "yes") return false;
  if (result.missed_sensitive_data !== "no") return false;
  if (result.about_project === "no") return false;
  return true;
}

async function uploadFolder(repo: string, localDir: string): Promise<void> {
  const code = await runCommandPassthrough("huggingface-cli", [
    "upload",
    repo,
    localDir,
    ".",
    "--repo-type",
    "dataset",
    "--commit-message",
    `pi-share-hf upload ${new Date().toISOString()}`,
  ]);
  if (code !== 0) {
    throw new Error(`Upload failed with exit code ${code}`);
  }
}
