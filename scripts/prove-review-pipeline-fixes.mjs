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

function firstSchemaValidParseChunkReviewResult(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = extractBalancedJsonObject(text, start);
    if (!candidate) continue;
    const parsed = parseChunkReviewCandidate(candidate);
    if (parsed) return parsed;
  }

  return undefined;
}

function parseChunkReviewResult(text) {
  let parsedResult;

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = extractBalancedJsonObject(text, start);
    if (!candidate) continue;
    const parsed = parseChunkReviewCandidate(candidate);
    if (parsed) parsedResult = parsed;
  }

  return parsedResult;
}

function parseChunkReviewCandidate(text) {
  try {
    const parsed = JSON.parse(text);
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

function extractBalancedJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch !== "}") continue;

    depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
    if (depth < 0) return undefined;
  }

  return undefined;
}

function createReviewPayload(summary, overrides = {}) {
  return JSON.stringify({
    about_project: "yes",
    shareable: "yes",
    missed_sensitive_data: "no",
    flagged_parts: [],
    summary,
    ...overrides,
  });
}

function parserScenarioDefinitions() {
  return [
    {
      name: "earlier irrelevant JSON before the real payload",
      sessionName: "2026-04-06T00-00-00-000Z_irrelevant-json.jsonl",
      outputLines: [
        'prefix {"foo":"bar"} middle text',
        createReviewPayload("accepted payload after irrelevant JSON"),
      ],
      expectedFirstSummary: "accepted payload after irrelevant JSON",
      expectedLastSummary: "accepted payload after irrelevant JSON",
      expectedShareable: "yes",
      expectedMissedSensitiveData: "no",
    },
    {
      name: "earlier schema-valid example before the final payload",
      sessionName: "2026-04-06T00-00-01-000Z_schema-example.jsonl",
      outputLines: [
        'prefix {"foo":"bar"} middle text',
        createReviewPayload("example only", {
          about_project: "no",
          shareable: "manual_review",
          missed_sensitive_data: "maybe",
        }),
        createReviewPayload("accepted valid payload"),
      ],
      expectedFirstSummary: "example only",
      expectedLastSummary: "accepted valid payload",
      expectedShareable: "yes",
      expectedMissedSensitiveData: "no",
    },
    {
      name: "later blocking payload overrides an earlier permissive payload",
      sessionName: "2026-04-06T00-00-02-000Z_later-blocking.jsonl",
      outputLines: [
        createReviewPayload("early permissive answer"),
        createReviewPayload("final answer blocks for possible secrets", {
          shareable: "manual_review",
          missed_sensitive_data: "maybe",
          flagged_parts: [{ reason: "possible secret", evidence: "token-like string" }],
        }),
      ],
      expectedFirstSummary: "early permissive answer",
      expectedLastSummary: "final answer blocks for possible secrets",
      expectedShareable: "manual_review",
      expectedMissedSensitiveData: "maybe",
    },
  ];
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
    const scenarios = parserScenarioDefinitions();
    const projectDir = path.join(tempRoot, "project");
    const workspaceDir = path.join(tempRoot, "workspace");
    const fakeBinDir = path.join(tempRoot, "bin");
    const fakeCounterPath = path.join(tempRoot, "pi-call-count");

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

    for (const scenario of scenarios) {
      const redactedPath = path.join(workspaceDir, "redacted", scenario.sessionName);
      const sessionEntry = {
        type: "message",
        message: {
          role: "user",
          content: `Review parser proof: ${scenario.name}`,
        },
      };
      writeFile(redactedPath, `${JSON.stringify(sessionEntry)}\n`);

      const fakeOutput = scenario.outputLines.join("\n");
      assert(legacyParseChunkReviewResult(fakeOutput) === undefined, `Legacy parser should fail for scenario: ${scenario.name}`);
      assert(firstSchemaValidParseChunkReviewResult(fakeOutput)?.summary === scenario.expectedFirstSummary, `First-match schema parsing should match the expected first valid payload for scenario: ${scenario.name}`);
      assert(parseChunkReviewResult(fakeOutput)?.summary === scenario.expectedLastSummary, `Current parser should match the expected last valid payload for scenario: ${scenario.name}`);
    }

    const fakePiScriptLines = [
      "#!/bin/sh",
      "if [ \"$1\" = \"--help\" ]; then",
      "  echo 'fake pi help'",
      "  exit 0",
      "fi",
      `counter_file=${JSON.stringify(fakeCounterPath)}`,
      'count="0"',
      'if [ -f "$counter_file" ]; then',
      '  count=$(cat "$counter_file")',
      "fi",
      'count=$((count + 1))',
      'printf "%s" "$count" > "$counter_file"',
      'case "$count" in',
    ];
    for (let index = 0; index < scenarios.length; index++) {
      const scenario = scenarios[index];
      fakePiScriptLines.push(`  ${index + 1})`);
      fakePiScriptLines.push("    cat <<'EOF'");
      fakePiScriptLines.push(...scenario.outputLines);
      fakePiScriptLines.push("EOF");
      fakePiScriptLines.push("    ;;");
    }
    fakePiScriptLines.push("  *)");
    fakePiScriptLines.push('    echo "unexpected fake pi invocation count: $count" >&2');
    fakePiScriptLines.push("    exit 1");
    fakePiScriptLines.push("    ;;");
    fakePiScriptLines.push("esac");

    writeFile(path.join(fakeBinDir, "pi"), fakePiScriptLines.join("\n"), 0o755);

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
        readmePath,
        agentsPath,
      ],
      {
        env,
        input: "y\n",
      },
    );

    for (const scenario of scenarios) {
      const reviewPath = path.join(workspaceDir, "review", `${scenario.sessionName}.review.json`);
      const reviewFile = JSON.parse(fs.readFileSync(reviewPath, "utf8"));

      assert(reviewFile.aggregate.summary === scenario.expectedLastSummary, `The CLI review should keep the expected final payload for scenario: ${scenario.name}`);
      assert(reviewFile.aggregate.shareable === scenario.expectedShareable, `The CLI review should keep the expected shareable value for scenario: ${scenario.name}`);
      assert(reviewFile.aggregate.missed_sensitive_data === scenario.expectedMissedSensitiveData, `The CLI review should keep the expected missed_sensitive_data value for scenario: ${scenario.name}`);
      assert(reviewFile.chunks.length === 1, `The proof session should review as a single chunk for scenario: ${scenario.name}`);
    }

    const reviewFile = JSON.parse(fs.readFileSync(path.join(workspaceDir, "review", `${scenarios[0].sessionName}.review.json`), "utf8"));
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
    assert(reviewFile.review_key !== legacyReviewKey, "The current review key should differ from the legacy pre-pipeline-version key");

    process.stdout.write(`parser proof: validated ${scenarios.length} parser scenarios, including irrelevant JSON, schema-valid example output, and a later blocking payload\n`);
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
