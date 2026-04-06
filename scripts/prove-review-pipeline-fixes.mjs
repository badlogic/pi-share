#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function logStep(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });

  if (result.status !== 0) {
    const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : "";
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${stdout}${stderr}`);
  }

  return result;
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
}

function legacyExtractJsonObject(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return undefined;
  return text.slice(firstBrace, lastBrace + 1);
}

function legacyParseChunkReviewResult(text) {
  const cleaned = legacyExtractJsonObject(text);
  if (!cleaned) return undefined;

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    if (!["yes", "no", "mixed"].includes(parsed.about_project)) return undefined;
    if (!["yes", "no", "manual_review"].includes(parsed.shareable)) return undefined;
    if (!["yes", "no", "maybe"].includes(parsed.missed_sensitive_data)) return undefined;
    if (typeof parsed.summary !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function legacyChunkSession(blocks, limit) {
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const next = `${block}\n\n`;
    if (current.length > 0 && current.length + next.length > limit) {
      chunks.push(current);
      current = "";
    }
    current += next;
  }

  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

async function loadSourceModules() {
  const reviewStateModule = await import(pathToFileURL(path.join(repoRoot, "src/review-state.ts")).href);
  const reviewSerializeModule = await import(pathToFileURL(path.join(repoRoot, "src/review-serialize.ts")).href);
  const workspaceModule = await import(pathToFileURL(path.join(repoRoot, "src/workspace.ts")).href);
  const typesModule = await import(pathToFileURL(path.join(repoRoot, "src/types.ts")).href);

  return {
    reviewStateModule,
    reviewSerializeModule,
    workspaceModule,
    typesModule,
  };
}

async function proveChunkSplitting(modules) {
  logStep("Proving oversized serialized blocks split into bounded continuation chunks");

  const { splitIntoReviewChunks, serializeEntryForReview } = modules.reviewSerializeModule;
  const { REVIEW_CHUNK_CHAR_LIMIT } = modules.typesModule;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-hf-chunk-proof-"));

  try {
    const messageText = "A".repeat(REVIEW_CHUNK_CHAR_LIMIT + 12_345);
    const entry = {
      type: "message",
      message: {
        role: "user",
        content: messageText,
      },
    };

    const sessionFile = path.join(tempRoot, "oversized.jsonl");
    writeFile(sessionFile, `${JSON.stringify(entry)}\n`);

    const serializedBlocks = serializeEntryForReview(entry);
    assert(serializedBlocks.length === 1, "Expected a single serialized block for the oversized user message");

    const legacyChunks = legacyChunkSession(serializedBlocks, REVIEW_CHUNK_CHAR_LIMIT);
    assert(legacyChunks.length === 1, "Legacy chunker should keep an oversized single block in one chunk");
    assert(legacyChunks[0].length > REVIEW_CHUNK_CHAR_LIMIT, "Legacy chunker should overflow the chunk limit on a single oversized block");

    const chunkDir = path.join(tempRoot, "chunks");
    const chunkFiles = await splitIntoReviewChunks(sessionFile, chunkDir);
    assert(chunkFiles.length > 1, "Current chunker should split an oversized serialized block across multiple files");

    const chunkTexts = chunkFiles.map((filePath) => fs.readFileSync(filePath, "utf8"));
    assert(chunkTexts.every((text) => text.length <= REVIEW_CHUNK_CHAR_LIMIT), "Every emitted review chunk must stay within REVIEW_CHUNK_CHAR_LIMIT");
    assert(chunkTexts.slice(1).every((text) => text.startsWith("[continued]\n")), "Continuation chunks should be explicitly marked");

    const reconstructed = chunkTexts.join("").replaceAll("[continued]\n", "").replace(/\n\n/g, "");
    assert(reconstructed === serializedBlocks[0], "Chunk splitting must preserve the entire serialized block without truncation");

    process.stdout.write(`chunk proof: emitted ${chunkFiles.length} bounded chunks, max size ${Math.max(...chunkTexts.map((text) => text.length))}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function proveParserAndReviewKey(modules) {
  logStep("Proving schema-aware JSON selection and pipeline-versioned review keys through the CLI");

  const { computeDenyHash, computeReviewKey, hashContextFiles } = modules.reviewStateModule;
  const { sha256Text } = modules.workspaceModule;
  const { REVIEW_CHUNK_CHAR_LIMIT, REVIEW_PROMPT_VERSION } = modules.typesModule;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-hf-review-proof-"));

  try {
    const projectDir = path.join(tempRoot, "project");
    const workspaceDir = path.join(tempRoot, "workspace");
    const fakeBinDir = path.join(tempRoot, "bin");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "redacted"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "reports"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "review"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "review-chunks"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "images"), { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });

    const readmePath = path.join(projectDir, "README.md");
    const agentsPath = path.join(projectDir, "AGENTS.md");
    writeFile(readmePath, "# Proof Project\n");
    writeFile(agentsPath, "# Agent Guidance\n");

    writeFile(
      path.join(workspaceDir, "workspace.json"),
      `${JSON.stringify({ cwd: projectDir, repo: "example/proof-dataset" }, null, 2)}\n`,
    );

    const sessionName = "2026-04-06T00-00-00-000Z_proof.jsonl";
    const redactedPath = path.join(workspaceDir, "redacted", sessionName);
    const sessionEntry = {
      type: "message",
      message: {
        role: "user",
        content: "Review parser proof",
      },
    };
    writeFile(redactedPath, `${JSON.stringify(sessionEntry)}\n`);

    const fakePiPath = path.join(fakeBinDir, "pi");
    writeFile(
      fakePiPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--help\" ]; then",
        "  echo 'fake pi help'",
        "  exit 0",
        "fi",
        "cat <<'EOF'",
        "prefix {\"foo\":\"bar\"} middle text",
        '{"about_project":"yes","shareable":"yes","missed_sensitive_data":"no","flagged_parts":[],"summary":"accepted valid payload"}',
        "EOF",
      ].join("\n"),
      0o755,
    );

    const fakeOutput = 'prefix {"foo":"bar"} middle text\n{"about_project":"yes","shareable":"yes","missed_sensitive_data":"no","flagged_parts":[],"summary":"accepted valid payload"}';
    assert(legacyParseChunkReviewResult(fakeOutput) === undefined, "Legacy parser should fail on output that contains an earlier irrelevant JSON object");

    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
    };

    run(
      "node",
      [
        "--experimental-strip-types",
        "src/index.ts",
        "review",
        "--workspace",
        workspaceDir,
        "--provider",
        "proof-provider",
        "--model",
        "proof-model",
        "--thinking",
        "medium",
        "--parallel",
        "1",
        "--session",
        sessionName,
        readmePath,
        agentsPath,
      ],
      {
        env,
        input: "y\n",
      },
    );

    const reviewPath = path.join(workspaceDir, "review", `${sessionName}.review.json`);
    const reviewFile = JSON.parse(fs.readFileSync(reviewPath, "utf8"));

    assert(reviewFile.aggregate.summary === "accepted valid payload", "The CLI review should extract the later schema-valid JSON payload");
    assert(reviewFile.aggregate.shareable === "yes", "The accepted payload should propagate through aggregate.shareable");
    assert(reviewFile.chunks.length === 1, "The proof session should review as a single chunk");

    const contextHashes = await hashContextFiles([readmePath, agentsPath]);
    const denyHash = computeDenyHash([]);
    const currentReviewKey = computeReviewKey(
      reviewFile.redacted_hash,
      contextHashes,
      "proof-provider",
      "proof-model",
      "medium",
      denyHash,
    );
    const legacyReviewKey = sha256Text(JSON.stringify({
      redactedHash: reviewFile.redacted_hash,
      contextHashes,
      provider: "proof-provider",
      model: "proof-model",
      thinking: "medium",
      denyHash,
      promptVersion: REVIEW_PROMPT_VERSION,
      chunkCharLimit: REVIEW_CHUNK_CHAR_LIMIT,
    }));

    assert(reviewFile.review_key === currentReviewKey, "The generated review sidecar should use the current pipeline-versioned cache key");
    assert(reviewFile.review_key !== legacyReviewKey, "The current review key should differ from the legacy pre-pipeline-version cache key");

    process.stdout.write("parser proof: review CLI accepted the schema-valid payload after an earlier irrelevant JSON object\n");
    process.stdout.write("review-key proof: generated sidecar key differs from the legacy pre-pipeline-version key\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  logStep("Running maintainer contribution gates");
  run("npm", ["run", "check"]);
  run("npm", ["run", "build"]);
  run("npm", ["pack", "--dry-run"]);

  const modules = await loadSourceModules();
  await proveChunkSplitting(modules);
  await proveParserAndReviewKey(modules);

  process.stdout.write("\nAll proof steps passed.\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nProof failed: ${message}\n`);
  process.exit(1);
});
