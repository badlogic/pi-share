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

# Releases

- Ensure the worktree is clean
- Run `npm run check`
- Run `npm run build`
- Verify the package with `npm pack --dry-run`
- Bump the version with `npm version <patch|minor|...>` so npm updates `package.json` and `package-lock.json`, creates the release commit, and creates a git tag
- Publish with `npm publish --access public`
- Push commit and tag with `git push --follow-tags`
