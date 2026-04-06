import fs from "node:fs";
import readline from "node:readline";
import { red } from "./colors.ts";
import type { GrepOptions, JsonValue, ListOptions } from "./types.ts";
import { loadReviewFile } from "./review-state.ts";
import { REJECT_FILE } from "./types.ts";
import { isRecord, workspacePath } from "./workspace.ts";

function loadRejectSet(workspace: string): Set<string> {
  const file = workspacePath(workspace, REJECT_FILE);
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean));
}

export function getUploadableSessionPaths(workspace: string): string[] {
  const reviewDir = workspacePath(workspace, "review");
  const redactedDir = workspacePath(workspace, "redacted");
  const rejectedByUser = loadRejectSet(workspace);
  if (!fs.existsSync(reviewDir)) return [];

  const paths: string[] = [];
  for (const file of fs.readdirSync(reviewDir).filter((f) => f.endsWith(".review.json")).sort()) {
    const review = loadReviewFile(workspacePath(reviewDir, file));
    if (!review) continue;
    const sessionFile = review.file;
    if (rejectedByUser.has(sessionFile)) continue;
    const aggregate = review.aggregate;
    if (aggregate.shareable !== "yes") continue;
    if (aggregate.missed_sensitive_data !== "no") continue;
    if (aggregate.about_project === "no") continue;

    const sessionPath = workspacePath(redactedDir, sessionFile);
    if (fs.existsSync(sessionPath)) paths.push(sessionPath);
  }
  return paths;
}

export async function runList(options: ListOptions): Promise<void> {
  const paths = options.uploadable ? getUploadableSessionPaths(options.workspace) : [];
  for (const p of paths) console.log(p);
}

export async function runGrep(options: GrepOptions): Promise<void> {
  const paths = getUploadableSessionPaths(options.workspace);
  if (paths.length === 0) return;

  const flags = options.ignoreCase ? "i" : "";
  const pattern = new RegExp(options.pattern, flags);

  let matches = 0;
  for (const filePath of paths) {
    const input = fs.createReadStream(filePath, { encoding: "utf-8" });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;

    for await (const line of reader) {
      lineNumber++;
      if (line.trim() === "") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;

      const lineMatches = findMatches(parsed as JsonValue, pattern, "$", []);
      for (const match of lineMatches) {
        matches++;
        console.log(`${filePath}:${lineNumber}:${match.jsonPath}`);
        console.log(`  ${match.snippet}`);
      }
    }
  }

  if (matches === 0) {
    process.exitCode = 1;
  }
}

function findMatches(value: JsonValue, pattern: RegExp, jsonPath: string, out: Array<{ jsonPath: string; snippet: string }>): Array<{ jsonPath: string; snippet: string }> {
  if (value === null) return out;

  if (typeof value === "string") {
    const localPattern = new RegExp(pattern.source, pattern.flags);
    const found = localPattern.exec(value);
    if (found && found.index >= 0) {
      out.push({ jsonPath, snippet: makeSnippet(value, found.index, found[0].length) });
    }
    return out;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return out;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      findMatches(value[i], pattern, `${jsonPath}[${i}]`, out);
    }
    return out;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${jsonPath}.${key}` : `${jsonPath}[${JSON.stringify(key)}]`;
    findMatches(child as JsonValue, pattern, childPath, out);
  }
  return out;
}

function makeSnippet(text: string, start: number, length: number): string {
  const left = Math.max(0, start - 50);
  const right = Math.min(text.length, start + length + 50);
  const prefixEllipsis = left > 0 ? "..." : "";
  const suffixEllipsis = right < text.length ? "..." : "";

  const before = text.slice(left, start).replace(/\s+/g, " ");
  const match = text.slice(start, start + length).replace(/\s+/g, " ");
  const after = text.slice(start + length, right).replace(/\s+/g, " ");

  return `${prefixEllipsis}${before}${red(match)}${after}${suffixEllipsis}`;
}
