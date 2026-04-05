import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { bold, cyan, green, red, yellow } from "./colors.ts";
import { REVIEW_CHUNK_CHAR_LIMIT, REVIEW_PROMPT_VERSION } from "./types.ts";
import type {
  AboutProject,
  ChunkReviewResult,
  MissedSensitiveData,
  ReviewFlaggedPart,
  ReviewOptions,
  SessionReviewFile,
  Shareable,
} from "./types.ts";
import { extractImagesFromSession, splitIntoReviewChunks } from "./review-serialize.ts";
import { runCommand } from "./process.ts";
import { computeReviewKey, hashContextFiles, loadReviewFile } from "./review-state.ts";
import { isRecord, readWorkspaceConfig, resetReviewDir, sha256File, workspacePath } from "./workspace.ts";

export async function runReview(options: ReviewOptions): Promise<void> {
  const config = readWorkspaceConfig(options.workspace);
  resetReviewDir(options.workspace);

  const contextFiles = resolveContextFiles(config.cwd, options.contextFiles);
  if (contextFiles.length === 0) {
    throw new Error("No context files found. Pass README.md/AGENTS.md explicitly or add them to the project root.");
  }
  for (const file of contextFiles) {
    if (!fs.existsSync(file)) throw new Error(`Context file not found: ${file}`);
  }

  const contextHashes = await hashContextFiles(contextFiles);
  const redactedDir = workspacePath(options.workspace, "redacted");
  let sessionFiles = fs.readdirSync(redactedDir).filter((file) => file.endsWith(".jsonl")).sort();
  if (options.session) {
    sessionFiles = sessionFiles.filter((file) => file.includes(options.session!));
    if (sessionFiles.length === 0) {
      console.log(`No session matching '${options.session}' found in workspace/redacted`);
      return;
    }
  }
  if (sessionFiles.length === 0) {
    console.log("No redacted session files found in workspace/redacted");
    return;
  }

  const hasImages = !config.noImages;
  const resolved = resolvePiDefaults(options.provider, options.model, options.thinking);

  console.log(`${bold("Workspace:")} ${options.workspace}`);
  console.log(`${bold("Redacted session files:")} ${cyan(String(sessionFiles.length))}`);
  console.log(`${bold("Context files:")} ${contextFiles.length}`);
  console.log(`${bold("Provider:")} ${resolved.provider}`);
  console.log(`${bold("Model:")} ${resolved.model}`);
  console.log(`${bold("Thinking:")} ${resolved.thinking}`);
  console.log(`${bold("Parallel:")} ${options.parallel}`);
  console.log(`${bold("Deny patterns:")} ${options.denyPatterns.length}`);

  const confirmed = await confirmPrompt("\nProceed with LLM review? (y/n) ");
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  let reviewed = 0;
  let skipped = 0;
  let denied = 0;

  interface ReviewWorkItem {
    file: string;
    redactedPath: string;
    reviewPath: string;
    redactedHash: string;
    reviewKey: string;
  }

  const workItems: ReviewWorkItem[] = [];

  for (const file of sessionFiles) {
    const redactedPath = workspacePath(options.workspace, "redacted", file);
    const reviewPath = workspacePath(options.workspace, "review", `${file}.review.json`);
    const redactedHash = await sha256File(redactedPath);
    const reviewKey = computeReviewKey(redactedHash, contextHashes, options.provider, options.model, options.thinking);
    const existingReview = loadReviewFile(reviewPath);

    if (existingReview?.review_key === reviewKey) {
      skipped++;
      continue;
    }

    if (options.denyPatterns.length > 0) {
      const content = fs.readFileSync(redactedPath, "utf-8");
      const matchedPattern = options.denyPatterns.find((p) => p.test(content));
      if (matchedPattern) {
        const denyReview = createDenyReview(
          file, contextFiles, contextHashes, redactedHash, reviewKey,
          options.provider, options.model, matchedPattern.source,
        );
        fs.writeFileSync(reviewPath, `${JSON.stringify(denyReview, null, 2)}\n`);
        denied++;
        continue;
      }
    }

    workItems.push({ file, redactedPath, reviewPath, redactedHash, reviewKey });
  }

  console.log(`${bold("Skipped existing:")} ${skipped}`);
  console.log(`${bold("Denied by pattern:")} ${denied}`);
  console.log(`${bold("Queued for LLM review:")} ${cyan(String(workItems.length))}`);

  const parallel = Math.max(1, options.parallel);

  async function processWorkItem(item: ReviewWorkItem): Promise<SessionReviewFile> {
    const chunkDir = workspacePath(options.workspace, "review-chunks", item.file);
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunkFiles = await splitIntoReviewChunks(item.redactedPath, chunkDir);
    const chunkResults: SessionReviewFile["chunks"] = [];

    let imageFiles: string[] = [];
    if (hasImages) {
      imageFiles = extractImagesFromSession(item.redactedPath, workspacePath(options.workspace, "images"), item.file);
    }

    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkFile = chunkFiles[i];
      const chunkText = fs.readFileSync(chunkFile, "utf-8");
      try {
        const result = await reviewChunkWithPi(
          config.cwd,
          contextFiles,
          chunkFile,
          i + 1,
          chunkFiles.length,
          options.provider,
          options.model,
          options.thinking,
          imageFiles,
        );
        chunkResults.push({
          chunk_index: i + 1,
          chunk_file: chunkFile,
          chars: chunkText.length,
          result,
        });
      } catch (error) {
        chunkResults.push({
          chunk_index: i + 1,
          chunk_file: chunkFile,
          chars: chunkText.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      file: item.file,
      context_files: contextFiles,
      context_hashes: contextHashes,
      provider: options.provider,
      model: options.model,
      redacted_hash: item.redactedHash,
      review_key: item.reviewKey,
      prompt_version: REVIEW_PROMPT_VERSION,
      chunk_count: chunkFiles.length,
      chunk_char_limit: REVIEW_CHUNK_CHAR_LIMIT,
      chunks: chunkResults,
      aggregate: aggregateChunkReviews(chunkResults),
    };
  }

  let nextIndex = 0;
  let inflight = 0;

  function printProgress(): void {
    process.stdout.write(`\r[${reviewed + denied + skipped}/${sessionFiles.length}] reviewed=${reviewed} denied=${denied} inflight=${inflight}`);
  }

  await new Promise<void>((resolve, reject) => {
    function startNext(): void {
      while (inflight < parallel && nextIndex < workItems.length) {
        const item = workItems[nextIndex++];
        inflight++;
        printProgress();
        processWorkItem(item)
          .then((result) => {
            fs.writeFileSync(item.reviewPath, `${JSON.stringify(result, null, 2)}\n`);
            reviewed++;
            inflight--;
            printProgress();
            startNext();
          })
          .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
      }
      if (inflight === 0 && nextIndex >= workItems.length) {
        resolve();
      }
    }
    startNext();
  });

  const summary = summarizeReviews(options.workspace, sessionFiles);

  console.log();
  console.log(`${bold("Reviewed:")} ${green(String(reviewed))}`);
  console.log(`${bold("Denied by pattern:")} ${yellow(String(denied))}`);
  console.log(`${bold("Skipped existing review:")} ${skipped}`);
  console.log(`${bold("Review sidecars:")} ${workspacePath(options.workspace, "review")}`);

  console.log();
  console.log(bold("Review summary"));
  console.log(`${bold("  Uploadable:")} ${green(String(summary.uploadable))}/${summary.total}`);
  console.log(`${bold("  Blocked:")} ${red(String(summary.blocked))}/${summary.total}`);
  console.log(`${bold("  shareable=yes:")} ${summary.shareable.yes}`);
  console.log(`${bold("  shareable=manual_review:")} ${yellow(String(summary.shareable.manual_review))}`);
  console.log(`${bold("  shareable=no:")} ${red(String(summary.shareable.no))}`);
  console.log(`${bold("  about_project=yes:")} ${summary.about.yes}`);
  console.log(`${bold("  about_project=mixed:")} ${yellow(String(summary.about.mixed))}`);
  console.log(`${bold("  about_project=no:")} ${red(String(summary.about.no))}`);
  console.log(`${bold("  missed_sensitive_data=no:")} ${summary.missed.no}`);
  console.log(`${bold("  missed_sensitive_data=maybe:")} ${yellow(String(summary.missed.maybe))}`);
  console.log(`${bold("  missed_sensitive_data=yes:")} ${red(String(summary.missed.yes))}`);
  if (summary.topReasons.length > 0) {
    console.log(bold("  Top reasons:"));
    for (const [reason, count] of summary.topReasons) {
      console.log(`    ${count}x ${reason}`);
    }
  }

  if (hasImages) {
    const imagesDir = workspacePath(options.workspace, "images");
    const imageCount = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).length : 0;
    if (imageCount > 0) {
      console.log(`\n${bold("Extracted images:")} ${cyan(String(imageCount))} -> ${imagesDir}`);
      console.log(yellow("Check these images manually for sensitive content before uploading."));
      console.log(yellow("If an image should not be shared, reject its session with: pi-share-hf reject <image-path>"));
      console.log(yellow("Rejecting an image rejects the entire session that contains it."));
    }
  }
}

function summarizeReviews(workspace: string, sessionFiles: string[]): {
  total: number;
  uploadable: number;
  blocked: number;
  shareable: Record<Shareable, number>;
  about: Record<AboutProject, number>;
  missed: Record<MissedSensitiveData, number>;
  topReasons: Array<[string, number]>;
} {
  const shareable: Record<Shareable, number> = { yes: 0, no: 0, manual_review: 0 };
  const about: Record<AboutProject, number> = { yes: 0, no: 0, mixed: 0 };
  const missed: Record<MissedSensitiveData, number> = { yes: 0, no: 0, maybe: 0 };
  const reasonCounts = new Map<string, number>();
  let uploadable = 0;
  let total = 0;

  for (const file of sessionFiles) {
    const review = loadReviewFile(workspacePath(workspace, "review", `${file}.review.json`));
    if (!review) continue;
    total++;
    const aggregate = review.aggregate;
    shareable[aggregate.shareable]++;
    about[aggregate.about_project]++;
    missed[aggregate.missed_sensitive_data]++;
    if (aggregate.shareable === "yes" && aggregate.missed_sensitive_data === "no" && aggregate.about_project !== "no") {
      uploadable++;
    }
    for (const part of aggregate.flagged_parts) {
      reasonCounts.set(part.reason, (reasonCounts.get(part.reason) ?? 0) + 1);
    }
  }

  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  return {
    total,
    uploadable,
    blocked: total - uploadable,
    shareable,
    about,
    missed,
    topReasons,
  };
}

function resolvePiDefaults(provider?: string, model?: string, thinking?: string): { provider: string; model: string; thinking: string } {
  let resolvedProvider = provider ?? "";
  let resolvedModel = model ?? "";
  let resolvedThinking = thinking ?? "";

  if (!resolvedProvider || !resolvedModel || !resolvedThinking) {
    const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        if (!resolvedProvider && typeof settings.defaultProvider === "string") resolvedProvider = settings.defaultProvider;
        if (!resolvedModel && typeof settings.defaultModel === "string") resolvedModel = settings.defaultModel;
        if (!resolvedThinking && typeof settings.defaultThinkingLevel === "string") resolvedThinking = settings.defaultThinkingLevel;
      } catch {
        // Ignore parse errors in settings.
      }
    }
  }

  return {
    provider: resolvedProvider || "(pi default)",
    model: resolvedModel || "(pi default)",
    thinking: resolvedThinking || "(pi default)",
  };
}

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

export function loadDenyPatterns(inputs: string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const lines = fs.readFileSync(resolved, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) patterns.push(new RegExp(trimmed));
      }
    } else {
      patterns.push(new RegExp(input));
    }
  }
  return patterns;
}

function resolveContextFiles(cwd: string, files: string[]): string[] {
  if (files.length > 0) {
    return files.map((file) => resolveContextFile(cwd, file));
  }

  const defaults = ["README.md", "AGENTS.md"]
    .map((file) => path.resolve(cwd, file))
    .filter((file) => fs.existsSync(file));

  return defaults;
}

function resolveContextFile(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

async function reviewChunkWithPi(
  cwd: string,
  contextFiles: string[],
  chunkFile: string,
  chunkIndex: number,
  chunkCount: number,
  provider?: string,
  model?: string,
  thinking?: string,
  imageFiles?: string[],
): Promise<ChunkReviewResult> {
  const hasSessionImages = imageFiles !== undefined && imageFiles.length > 0;
  const prompt = createReviewPrompt(chunkIndex, chunkCount, hasSessionImages);
  const args = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-tools",
  ];

  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  for (const file of contextFiles) args.push(`@${file}`);
  args.push(`@${chunkFile}`);
  if (hasSessionImages && chunkIndex === 1) {
    for (const img of imageFiles) args.push(`@${img}`);
  }
  args.push("-p", prompt);

  const result = await runCommand("pi", args, cwd);
  if (!result.ok) {
    throw new Error(`pi review failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const parsed = parseChunkReviewResult(result.stdout);
  if (!parsed) {
    throw new Error(`Could not parse JSON review result from pi output:\n${result.stdout}`);
  }
  return parsed;
}

function createReviewPrompt(chunkIndex: number, chunkCount: number, hasImages: boolean): string {
  return [
    "Review a redacted pi session chunk for public OSS dataset sharing.",
    "",
    hasImages
      ? "The attached files include project context files, the session chunk, and images extracted from the session. Review the images for sensitive content (screenshots of private data, credentials, personal information, non-project content)."
      : "The attached files include project context files followed by the session chunk as the last file.",
    "Judge whether the session chunk is about the OSS project, whether it is fit to share publicly on Hugging Face, and whether there appears to be missed sensitive data after deterministic redaction.",
    "The session chunk is a serialized plain-text transcript derived from a redacted session file. It may contain user messages, assistant text, thinking blocks, tool calls, tool results, bash output, custom entries, branch summaries, compaction summaries, preserved image markers, and verbatim JSON for details/custom data.",
    "",
    `This is chunk ${chunkIndex} of ${chunkCount}.`,
    "",
    "Return ONLY strict JSON with this schema:",
    "{",
    '  "about_project": "yes" | "no" | "mixed",',
    '  "shareable": "yes" | "no" | "manual_review",',
    '  "missed_sensitive_data": "yes" | "no" | "maybe",',
    '  "flagged_parts": [{ "reason": string, "evidence": string }],',
    '  "summary": string',
    "}",
    "",
    "Guidance:",
    "- about_project=no if the chunk is clearly unrelated to the OSS project.",
    "- about_project=mixed if it contains both project-related and unrelated/private content.",
    "- shareable=yes only if the chunk looks public-appropriate after redaction.",
    "- shareable=manual_review if there is uncertainty.",
    "- missed_sensitive_data=yes if you see likely missed secrets, API keys, tokens, passwords, PII, or confidential data.",
    "- missed_sensitive_data=maybe if you suspect it but are not confident.",
    "- Pay special attention to possible leaked API keys, bearer tokens, OAuth tokens, secret-like strings, and credentials that deterministic redaction may have missed.",
    "- Email addresses in git-related public OSS context are acceptable by default. Examples: commit author lines, public git metadata, repository history, issue or PR discussions about public contributors. Do NOT flag those by themselves as missed sensitive data.",
    "- Local filesystem paths inside the current OSS project are acceptable by default. Do NOT flag project-local paths, workspace paths, temporary screenshot paths, or username-like path components by themselves.",
    "- Only flag paths or local machine details when they clearly point to unrelated private work, auth files, mail, finance, personal documents, private infrastructure, or other non-OSS sensitive context.",
    "- Do NOT treat assistant thinking blocks or provider thinking signatures as missed sensitive data by themselves. They are expected to remain in the dataset unless they contain other clearly sensitive content.",
    "- Do NOT flag preserved embedded images merely because the image payload remains. Only flag them if there is specific evidence that the image likely contains sensitive content.",
    "- flagged_parts should quote short redacted excerpts only. Do not invent evidence.",
  ].join("\n");
}

function parseChunkReviewResult(text: string): ChunkReviewResult | undefined {
  const cleaned = extractJsonObject(text);
  if (!cleaned) return undefined;

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (!isAboutProject(parsed.about_project)) return undefined;
    if (!isShareable(parsed.shareable)) return undefined;
    if (!isMissedSensitiveData(parsed.missed_sensitive_data)) return undefined;
    if (typeof parsed.summary !== "string") return undefined;
    const flaggedParts = Array.isArray(parsed.flagged_parts)
      ? parsed.flagged_parts
          .map((item) => parseFlaggedPart(item))
          .filter((item): item is ReviewFlaggedPart => item !== undefined)
      : [];

    return {
      about_project: parsed.about_project,
      shareable: parsed.shareable,
      missed_sensitive_data: parsed.missed_sensitive_data,
      flagged_parts: flaggedParts,
      summary: parsed.summary,
    };
  } catch {
    return undefined;
  }
}

function parseFlaggedPart(value: unknown): ReviewFlaggedPart | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.reason !== "string") return undefined;
  if (typeof value.evidence !== "string") return undefined;
  return { reason: value.reason, evidence: value.evidence };
}

function isAboutProject(value: unknown): value is AboutProject {
  return value === "yes" || value === "no" || value === "mixed";
}

function isShareable(value: unknown): value is Shareable {
  return value === "yes" || value === "no" || value === "manual_review";
}

function isMissedSensitiveData(value: unknown): value is MissedSensitiveData {
  return value === "yes" || value === "no" || value === "maybe";
}

function extractJsonObject(text: string): string | undefined {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return undefined;
  return text.slice(firstBrace, lastBrace + 1);
}

function aggregateChunkReviews(chunks: SessionReviewFile["chunks"]): ChunkReviewResult {
  const successful = chunks.flatMap((chunk) => (chunk.result ? [{ ...chunk.result, chunk_index: chunk.chunk_index }] : []));
  if (successful.length === 0) {
    return {
      about_project: "mixed",
      shareable: "manual_review",
      missed_sensitive_data: "maybe",
      flagged_parts: [{ reason: "review-failed", evidence: "All chunk reviews failed" }],
      summary: "All chunk reviews failed.",
    };
  }

  let aboutProject: AboutProject = successful[0].about_project;
  const aboutSet = new Set(successful.map((chunk) => chunk.about_project));
  if (aboutSet.size > 1 || aboutSet.has("mixed")) aboutProject = "mixed";

  let shareable: Shareable = "yes";
  if (successful.some((chunk) => chunk.shareable === "no")) shareable = "no";
  else if (successful.some((chunk) => chunk.shareable === "manual_review")) shareable = "manual_review";

  let missedSensitiveData: MissedSensitiveData = "no";
  if (successful.some((chunk) => chunk.missed_sensitive_data === "yes")) missedSensitiveData = "yes";
  else if (successful.some((chunk) => chunk.missed_sensitive_data === "maybe")) missedSensitiveData = "maybe";

  const flaggedParts = successful.flatMap((chunk) =>
    chunk.flagged_parts.map((flag) => ({
      chunk_index: chunk.chunk_index,
      reason: flag.reason,
      evidence: flag.evidence,
    }))
  );

  const summary = successful.map((chunk) => chunk.summary).filter(Boolean).join(" | ");

  return {
    about_project: aboutProject,
    shareable,
    missed_sensitive_data: missedSensitiveData,
    flagged_parts: flaggedParts,
    summary,
  };
}

function createDenyReview(
  file: string,
  contextFiles: string[],
  contextHashes: Record<string, string>,
  redactedHash: string,
  reviewKey: string,
  provider: string | undefined,
  model: string | undefined,
  patternSource: string,
): SessionReviewFile {
  return {
    file,
    context_files: contextFiles,
    context_hashes: contextHashes,
    provider,
    model,
    redacted_hash: redactedHash,
    review_key: reviewKey,
    prompt_version: REVIEW_PROMPT_VERSION,
    chunk_count: 0,
    chunk_char_limit: REVIEW_CHUNK_CHAR_LIMIT,
    chunks: [],
    aggregate: {
      about_project: "no",
      shareable: "no",
      missed_sensitive_data: "no",
      flagged_parts: [{ reason: "deny-pattern", evidence: patternSource }],
      summary: `Session denied by pattern: ${patternSource}`,
    },
  };
}
