import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretPattern } from "./types.ts";

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "openai-project", regex: /sk-proj-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "anthropic", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "openrouter", regex: /sk-or-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "groq", regex: /gsk_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "github", regex: /gh[pousr]_[A-Za-z0-9]{30,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "huggingface", regex: /hf_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "aws-access-key", regex: /AKIA[A-Z0-9]{12,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "xai", regex: /xai-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "google-ai", regex: /AIza[A-Za-z0-9_-]{30,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "cerebras", regex: /csk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
  { name: "bearer-token", regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g, replacement: "Bearer [REDACTED_SECRET]", severity: "critical" },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED_SECRET]", severity: "critical" },
];

export function buildLiteralSecrets(envFile: string, secretInputs: string[]): Array<{ name: string; value: string; replacement: string }> {
  const secrets = new Map<string, string>();
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf-8");
    const pattern = /^export\s+([A-Za-z_][A-Za-z_0-9]*)=["']?([^"'\n#]+)/gm;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      const value = match[2].trim().replace(/["']$/, "");
      if (looksSensitiveName(name) && value.length > 4) {
        secrets.set(name, value);
      }
    }
  }

  let secretIndex = 1;
  for (const input of secretInputs) {
    const resolved = path.resolve(input);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const lines = fs.readFileSync(resolved, "utf-8").split("\n");
      for (const line of lines) {
        const value = line.trim();
        if (value.length > 0) {
          secrets.set(`SECRET_${secretIndex++}`, value);
        }
      }
      continue;
    }

    if (input.length > 0) {
      secrets.set(`SECRET_${secretIndex++}`, input);
    }
  }

  return [...secrets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, value]) => ({
      name,
      value,
      replacement: `[REDACTED_${name}]`,
    }));
}

export function looksSensitiveName(name: string): boolean {
  const upper = name.toUpperCase();
  return ["KEY", "TOKEN", "SECRET", "PASSWORD", "PWD", "COOKIE"].some((part) => upper.includes(part));
}

export function countOccurrences(text: string, value: string): number {
  if (!value) return 0;
  return text.split(value).length - 1;
}

export function countRegexMatches(text: string, regex: RegExp): number {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const globalRegex = new RegExp(regex.source, flags);
  let count = 0;
  while (globalRegex.exec(text) !== null) count++;
  return count;
}

export function computeSecretHash(envFile: string, secretInputs: string[]): string {
  const secrets = buildLiteralSecrets(envFile, secretInputs)
    .map((entry) => entry.value)
    .sort()
    .join("\n");
  return `sha256:${createHash("sha256").update(secrets).digest("hex")}`;
}
