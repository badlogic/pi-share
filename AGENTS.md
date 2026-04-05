# Project

This project is a small Node.js CLI for collecting, reviewing, and uploading redacted pi session files for a specific cwd.

# TypeScript

This project runs TypeScript directly via Node.js type stripping.

That means not all TypeScript syntax is supported at runtime. Avoid TypeScript features that require full transpilation rather than simple type erasure.

Prefer plain JavaScript-compatible syntax with type annotations only.

In particular, be careful with features like:
- parameter properties
- enums
- namespaces
- decorators
- other TS-only runtime syntax

# Workflow

After modifying source files, run:

```bash
npm run check
```

Fix all reported issues before considering the work done.
