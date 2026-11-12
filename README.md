# Deontic

Deterministic static analyzer, Turn-0 context budget profiler, progressive-disclosure path splitter, and cross-tool synchronization engine for AI coding agent Harness Files and Model Context Protocol (MCP) configurations.

## Table of Contents

- [Overview](#overview)
- [Why Deontic](#why-deontic)
- [Supported Agent Profiles and Harness Files](#supported-agent-profiles-and-harness-files)
- [Core Concepts](#core-concepts)
- [Diagnostic Rules](#diagnostic-rules)
- [Installation and Setup](#installation-and-setup)
- [CLI Usage](#cli-usage)
  - [`deontic check`](#deontic-check)
  - [`deontic cost`](#deontic-cost)
  - [`deontic split`](#deontic-split)
  - [`deontic sync`](#deontic-sync)
  - [`deontic trace`](#deontic-trace)
  - [`deontic mcp-probe`](#deontic-mcp-probe)
- [Configuration](#configuration)
- [Inline Pragmas and Markers](#inline-pragmas-and-markers)
- [Programmatic API (`@deontic/core`)](#programmatic-api-deonticcore)
- [GitHub Action](#github-action)
- [Development](#development)
- [License](#license)

---

## Overview

Modern software repositories accumulate instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `SKILL.md`) and MCP server configurations (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`). Over time, these files drift out of sync with the codebase and with each other:

1. **Contradictory Directives**: Root and scoped files (or parallel configurations across Claude Code, Cursor, and Codex) issue opposite imperative rules for the same directory or file glob.
2. **Dead References**: File paths, directories, `@import` targets, `package.json` scripts, and `Makefile` targets are renamed or deleted while remaining referenced in agent instructions.
3. **Turn-0 Context Bloat**: Unscoped root instructions, ASCII directory trees, and oversized MCP tool schemas consume thousands of tokens at session startup and push agents past the ~150-Directive adherence cliff or the 32 KiB silent-truncation cap.
4. **Cross-Tool Drift**: Teams using multiple coding agents manually duplicate rules across `.claude/rules/*.md`, `.cursor/rules/*.mdc`, and `AGENTS.md`.

Deontic treats AI agent instructions and MCP configurations as first-class source artifacts that can be statically verified, budgeted, refactored into path-scoped rules, and synchronized deterministically in milliseconds with zero LLM calls.

---

## Why Deontic

- **Pure-TypeScript Ontology and Finite-Domain Constraint Solver**: Resolves lexical, taxonomic, subtype, entailment, and mutual-exclusion conflicts (`Prisma` as a subtype of `database`, `Testcontainers` entailing `Docker`, `pnpm` vs. `npm` mutual exclusion) in under 5ms with zero WASM cold-start overhead.
- **Two-Tier Witness-Based Glob Intersection**: Tests directive scopes against tracked repository files first to surface concrete Witness Paths (for example, `packages/api/src/router.ts`), falling back to synthesized candidate paths when globs target uncreated files.
- **Git-Aware Dead Reference Resolution**: Distinguishes dead references from template placeholders, build outputs, and deprecated/prohibited paths (`Do not import from src/legacy/`), and inspects Git rename history (`git log --diff-filter=D` / `git show -M`) to provide automatic `--fix` edits.
- **Per-Agent Context Budgeting**: Evaluates contradictions across a unified repository scope while computing Turn-0 Load and Directive adherence thresholds separately per Agent Profile (`claude-code`, `cursor`, `codex`, `copilot`).
- **Static MCP Fingerprint Registry with Opt-In Live Probe**: Profiles MCP server token costs and parameter casing collisions instantaneously during static analysis, while supporting live JSON-RPC `tools/list` stdio handshakes on demand.
- **Session Trace ROI Correlation**: Correlates local agent session transcripts (`~/.claude/projects/**/*.jsonl`) against root Rule Sections to identify Dead Rule Sections with a 0% Session Hit Rate.

---

## Supported Agent Profiles and Harness Files

Deontic automatically discovers and classifies Harness Files across four canonical Agent Profiles:

| Agent Profile | Format Identifier | Recognized Repository Paths | Default Effective Scope |
| :--- | :--- | :--- | :--- |
| `claude-code` | `claude-md` | `CLAUDE.md`, `CLAUDE.local.md`, `**/CLAUDE.md`, `**/CLAUDE.local.md` | Root (`**/*`, Turn-0) or subdirectory (`<dir>/**`) |
| `claude-code` | `claude-rule` | `.claude/rules/*.{md,mdc}`, `**/.claude/rules/*.{md,mdc}` | Frontmatter `paths` / `globs`, or `**/*` (Turn-0 at root) |
| `claude-code` | `claude-skill` | `.claude/skills/**/SKILL.md`, `**/.claude/skills/**/SKILL.md` | On-demand (`alwaysApply: true` opts into Turn-0) |
| `claude-code` | `claude-settings` | `.claude/settings.json`, `.claude/settings.local.json` | Root (`**/*`, Turn-0) |
| `cursor` | `cursor-mdc` | `.cursor/rules/*.{mdc,md}`, `**/.cursor/rules/*.{mdc,md}` | Frontmatter `globs` / `alwaysApply` |
| `cursor` | `cursorrules` | `.cursorrules`, `**/.cursorrules` | Root (`**/*`, Turn-0) or subdirectory (`<dir>/**`) |
| `codex` | `agents-md` | `AGENTS.md`, `**/AGENTS.md` | Root (`**/*`, Turn-0) or subdirectory (`<dir>/**`) |
| `codex` | `gemini-md` | `GEMINI.md`, `**/GEMINI.md` | Root (`**/*`, Turn-0) or subdirectory (`<dir>/**`) |
| `codex` | `windsurfrules` | `.windsurfrules`, `**/.windsurfrules` | Root (`**/*`, Turn-0) or subdirectory (`<dir>/**`) |
| `copilot` | `copilot-instructions` | `.github/copilot-instructions.md` | Root (`**/*`, Turn-0) |
| `copilot` | `copilot-scoped` | `.github/instructions/*.instructions.md` | Frontmatter `applyTo` |
| Multi-profile | `mcp-config` | `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `mcp.json`, `claude_desktop_config.json` | Root (`**/*`, Turn-0) |

---

## Core Concepts

Deontic uses a strict domain vocabulary (defined in `GLOSSARY.md`):

- **Harness File**: Any instruction document or tool-configuration file in a repository that shapes an AI coding agent's context or toolset.
- **Agent Profile**: The specific combination of Harness Files and scope-loading rules that a single AI coding tool (`claude-code`, `cursor`, `codex`, or `copilot`) activates during a session.
- **Rule Section**: A cohesive, heading-delimited or frontmatter-scoped block within a Harness File that groups related guidance and serves as the unit of progressive disclosure and usage tracking.
- **Directive**: An atomic imperative statement (`MUST`, `MUST_NOT`, `SHOULD`, `SHOULD_NOT`) that constrains how an agent writes code, runs commands, or uses tools.
- **Context Note**: A non-imperative descriptive statement, architecture overview, or directory tree in a Harness File that consumes context budget without imposing a behavioral constraint.
- **Derivable Directory Tree**: A Context Note consisting of an ASCII file tree or a pure path-catalog list that duplicates repository structure an agent can discover directly from the filesystem.
- **Effective Scope**: The set of repository file paths where a Directive or Rule Section is active when an agent reads or edits code.
- **Turn-0 Load**: The baseline tokens, Directives, and tool schemas injected into an agent's context window at session start before any repository file is opened.
- **Witness Path**: A concrete repository file path (or synthesized candidate path when no matching file exists yet) that falls within the Effective Scopes of two conflicting Directives, proving their scopes overlap.
- **Session Hit Rate**: The percentage of recorded local agent sessions in which the agent touches at least one file or runs at least one command matching a Rule Section's scope.

---

## Diagnostic Rules

Deontic executes seven static analysis passes (`00-imports` through `06-trace-roi`) and emits nine diagnostic codes (`CTX001` through `CTX009`):

| Code | Default Severity | Name | Description & Auto-Fix Support |
| :--- | :--- | :--- | :--- |
| `CTX001` | `error` (HARD vs. HARD) / `warning` (SOFT) | **Same-Scope Contradiction** | Two Directives with overlapping Effective Scopes impose incompatible obligations or mutually exclusive targets without an ancestor-child override relationship. Reports a concrete Witness Path. |
| `CTX002` | `error` (byte cap) / `warning` (directives & trees) | **Turn-0 Bloat & Adherence Cliff** | Turn-0 Load or an individual Harness File exceeds `maxFileBytes` (default 32 KiB / 32,768 bytes), active Directives exceed `maxDirectives` (default 150), or a file contains a Derivable Directory Tree (ASCII tree >= 8 lines or path-catalog bullet run >= 10 items). |
| `CTX003` | `warning` | **Unscoped Ancestor Override** | A narrower child Harness File reverses a Directive from an always-loaded root Harness File, leaving both conflicting Directives visible simultaneously in the agent's context window. **Supports `--fix`** by qualifying the root Directive with `(except in <child-globs>)`. |
| `CTX004` | `error` | **Dead Reference (Path)** | A file or directory path referenced in a Harness File does not exist in the workspace (excluding negated/deprecated historical paths, templates, and build outputs). **Supports `--fix`** when Git rename history or unique basename resolution locates the moved path. |
| `CTX005` | `error` | **Dead Script Reference** | A `pnpm`/`npm`/`yarn`/`bun` script or `Makefile` target referenced in a Harness File does not exist in `package.json` or `Makefile`. **Supports `--fix`** when a unique close script match is identified via prefix or Levenshtein edit distance. |
| `CTX006` | `error` | **Broken or Circular `@import`** | An `@path/to/file` include directive points to a non-existent file or forms a circular include cycle across files. |
| `CTX007` | `warning` | **MCP Schema Overload & Casing Collision** | Active MCP tools for an Agent Profile exceed `maxMcpTools` (default 40), a single MCP tool schema exceeds 800 tokens, or active MCP servers exhibit a Parameter Casing Collision (for example, `repo_name` vs. `repoName`). |
| `CTX008` | `warning` | **Redundant Directive** | Two Directives within the same Agent Profile have overlapping Effective Scopes and are either semantic duplicates in the ontology or textual near-duplicates (Jaccard token similarity >= 0.75). |
| `CTX009` | `warning` | **Dead Rule Section** | A domain-specific Rule Section loaded unconditionally at repository root (`Turn-0 Load`) has a 0% Session Hit Rate across >= 5 recorded agent sessions. |

---

## Installation and Setup

### Prerequisites

- **Node.js**: `>= 20.0.0`
- **pnpm**: `9.x` (specified via `packageManager: pnpm@9.15.4` for monorepo development)

### Install in a Project

```bash
pnpm add -D @deontic/cli
# or run directly:
npx @deontic/cli check
```

### Build from Source (Monorepo)

```bash
git clone https://github.com/thilak15/deontic.git
cd deontic
pnpm install
pnpm build
```

Once built, you can invoke the CLI binary directly:

```bash
node packages/cli/dist/bin.js check
```

---

## CLI Usage

The `deontic` CLI provides six subcommands. If no subcommand is specified, `deontic` defaults to `check`.

```text
deontic [command] [flags]
```

### `deontic check`

Runs all static analysis passes across discovered Harness Files and MCP configurations in the workspace.

```bash
deontic check [options]
```

**Options:**

- `--format <pretty|json|sarif|github>`: Output reporter format (default: `pretty`).
  - `pretty`: Human-readable terminal report with file locations, line/column spans, Witness Paths, and remediation suggestions.
  - `json`: Complete structured `WorkspaceAnalysisResult` JSON payload.
  - `sarif`: SARIF 2.1.0 JSON report suitable for GitHub Code Scanning.
  - `github`: GitHub Actions workflow annotations (`::error file=...,line=...::...` and `::warning ...`).
- `--agent <claude-code|cursor|codex|copilot>`: Filter diagnostics to a single Agent Profile.
- `--strict`: Exit with code `1` on warnings as well as errors (by default, only `error`-severity diagnostics cause a non-zero exit code).
- `--fix`: Automatically apply safe, deterministic fixes on disk (`CTX003` ancestor scope exclusions, `CTX004` renamed file references, `CTX005` closest script names) and re-verify the workspace.
- `--probe`: Spawn configured stdio MCP servers to query live `tools/list` schemas during `CTX007` evaluation instead of using the static fingerprint registry alone.
- `--trace-dir <path>`: Custom directory containing `.jsonl` session transcripts for `CTX009` evaluation (defaults to `~/.claude/projects/<encoded-cwd>`).

**Examples:**

```bash
# Run standard check with terminal output
deontic check

# Check only Claude Code harness files and fail on warnings
deontic check --agent claude-code --strict

# Automatically fix dead references and unscoped ancestor overrides
deontic check --fix

# Output SARIF for code scanning
deontic check --format sarif > deontic.sarif
```

---

### `deontic cost`

Profiles Turn-0 Load, total repository token and Directive counts, Derivable Directory Tree waste, and MCP tool schema overhead per Agent Profile.

```bash
deontic cost [options]
```

**Options:**

- `--format <pretty|json>`: Output a visual bar-chart breakdown (`pretty`) or structured JSON (`json`).
- `--probe`: Query live MCP servers via JSON-RPC `tools/list` for exact schema token counts.

**Example Output (`pretty`):**

```text
=== Deontic Turn-0 Load & Context Budget Report ===

Agent Profile: claude-code
  Turn-0 Load: 2410 tokens (7840 bytes, 42/150 imperative Directives)
  Total Repo Scope: 3890 tokens (68 Directives across 4 Harness Files)
  Derivable Directory Tree Waste: 310 tokens
  MCP Schema Load: 1450 tokens across 6 tools (1 servers)
    - postgres (.mcp.json): 6 tools, 1450 tokens [registry]
  Files Breakdown:
    [████████████████] CLAUDE.md (Turn-0): 960 tokens, 42 Directives, 310 tree-waste tokens
    [████████░░░░░░░░] .claude/rules/api.md (Scoped): 480 tokens, 14 Directives
```

---

### `deontic split`

Analyzes root Harness Files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`), identifies domain-specific Rule Sections (such as Database/Prisma, E2E/Playwright, Frontend/React, API, Auth, Billing, or Infrastructure), infers their repository path globs, and extracts them into path-scoped rule files while retaining global sections at root.

```bash
deontic split [options]
```

**Options:**

- `--target <claude|cursor>`: Target format for extracted rule files. `claude` generates `.claude/rules/<slug>.md` with `paths:` YAML frontmatter; `cursor` generates `.cursor/rules/<slug>.mdc` with `globs:` and `alwaysApply: false` frontmatter (default: `claude`).
- `--write` (or `--fix`): Write the extracted rule files and updated root Harness Files to disk. Without `--write`, `deontic split` runs as a dry-run preview and reports projected Turn-0 token savings.
- `--format <pretty|json>`: Output format (default: `pretty`).

**Examples:**

```bash
# Preview Turn-0 token reduction without modifying files
deontic split --target claude

# Write extracted path-scoped rules to .claude/rules/*.md and update CLAUDE.md
deontic split --target claude --write

# Extract rules into Cursor .cursor/rules/*.mdc files
deontic split --target cursor --write
```

---

### `deontic sync`

Synchronizes canonical instructions across Claude Code (`.claude/rules/*.md`, `CLAUDE.md`), Cursor (`.cursor/rules/*.mdc`, `.cursorrules`), and Codex/universal `AGENTS.md` files (routing directory-scoped rules to `<dir>/AGENTS.md` and root rules to `AGENTS.md` using `<!-- deontic:sync ... -->` markers that preserve user-authored content outside synced blocks).

```bash
deontic sync [options]
```

**Options:**

- `--from <claude|cursor>`: Canonical source of truth to synchronize from (default: `claude`).
- `--write`: Write synchronized target files to disk.
- `--check`: Verify that all target Harness Files are in sync without modifying disk; exits with code `1` if any target file has drifted.
- `--format <pretty|json>`: Output format (default: `pretty`).

**Examples:**

```bash
# Synchronize from Claude Code rules to Cursor (.cursor/rules/*.mdc) and AGENTS.md
deontic sync --from claude --write

# Verify in CI that synced files have not drifted
deontic sync --from claude --check
```

---

### `deontic trace`

Correlates local coding agent session logs (`.jsonl` tool-call transcripts) against Harness File Rule Sections to measure each section's **Session Hit Rate** and surface **Dead Rule Sections** (`CTX009`).

```bash
deontic trace [options]
```

**Options:**

- `--trace-dir <path>`: Path to directory containing `.jsonl` session logs. If omitted, Deontic automatically checks `~/.claude/projects/<encoded-cwd>`.
- `--format <pretty|json>`: Output format (default: `pretty`).

**Example:**

```bash
deontic trace --trace-dir ./traces
```

---

### `deontic mcp-probe`

Spawns configured stdio MCP servers (from `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `mcp.json`, or `claude_desktop_config.json`), performs a JSON-RPC 2.0 `initialize` + `tools/list` handshake (with a 3-second timeout and automatic static fallback on error), and reports exact tool counts, token costs, and Parameter Casing Collisions.

```bash
deontic mcp-probe [options]
```

**Options:**

- `--format <pretty|json>`: Output format (default: `pretty`).

---

## Configuration

Deontic works out of the box with zero configuration. To customize thresholds, ignored paths, or rule severities, create a `deontic.json` file at the repository root or add a `"deontic"` key to your root `package.json`.

### Example `deontic.json`

```json
{
  "ignore": [
    "fixtures/**",
    "docs/archive/**"
  ],
  "maxDirectives": 150,
  "maxMcpTools": 40,
  "maxFileBytes": 32768,
  "rules": {
    "CTX001": "error",
    "CTX002": "warn",
    "CTX003": "warn",
    "CTX004": "error",
    "CTX005": "error",
    "CTX006": "error",
    "CTX007": "warn",
    "CTX008": "warn",
    "CTX009": "off"
  }
}
```

### Configuration Fields

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `ignore` | `string[]` | `[]` | Additional glob patterns to exclude from workspace discovery (merged with `.gitignore`). |
| `maxDirectives` | `number` | `150` | Maximum simultaneous imperative Directives per Agent Profile before triggering `CTX002`. |
| `maxMcpTools` | `number` | `40` | Maximum active MCP tools per Agent Profile before triggering `CTX007`. |
| `maxFileBytes` | `number` | `32768` | Maximum Turn-0 or single-file byte size (32 KiB) before triggering a `CTX002` error. |
| `rules` | `Record<DiagnosticCode, 'error' \| 'warn' \| 'warning' \| 'off'>` | `{}` | Per-rule severity overrides (`CTX001` through `CTX009`). Setting a rule to `"off"` disables it. |

---

## Inline Pragmas and Markers

You can control Deontic's analyzer directly inside Markdown Harness Files using HTML comment pragmas:

### 1. Suppressing Diagnostics (`deontic-ignore`)

Suppress all diagnostics or specific diagnostic codes on the current/next line:

```markdown
<!-- deontic-ignore: CTX004, CTX005 -->
Run `pnpm legacy:migrate` against `src/old-schema.sql` when testing archival backups.
```

Suppress diagnostics for an entire file by placing `deontic-ignore-file` at the top of the file:

```markdown
<!-- deontic-ignore-file: CTX002 -->
```

### 2. Declaring Intentional Child Overrides (`deontic-override`)

When a scoped child Harness File intentionally overrides an always-loaded root Directive (`CTX003`), you can declare the intentional override in the child file instead of modifying the root file:

```markdown
<!-- deontic-override: packages/legacy/** -->
In this package, use `npm` instead of `pnpm`.
```

### 3. Cross-Tool Sync Blocks (`deontic:sync`)

Managed automatically by `deontic sync`. Content outside `<!-- deontic:sync ... -->` and `<!-- /deontic:sync -->` markers in `AGENTS.md` or `CLAUDE.md` is preserved across sync runs:

```markdown
<!-- deontic:sync id="database" globs="prisma/**, src/db/**" -->
# Database Rules
Always use Prisma migrations for schema updates.
<!-- /deontic:sync -->
```

---

## Programmatic API (`@deontic/core`)

All analysis, profiling, splitting, and synchronization capabilities are exported by `@deontic/core` for integration into custom build tools, language servers, or test suites.

```typescript
import {
  analyzeWorkspace,
  profileWorkspaceCost,
  splitWorkspace,
  syncWorkspace,
  correlateWorkspaceTraces,
  probeMcpServers,
} from '@deontic/core';

// 1. Run static analysis and auto-fixes
const analysis = await analyzeWorkspace({
  cwd: process.cwd(),
  agent: 'claude-code',
  fix: false,
});
console.log(analysis.diagnostics);

// 2. Profile Turn-0 Load and MCP token budgets
const costReport = await profileWorkspaceCost({
  cwd: process.cwd(),
  probe: false,
});
console.log(costReport.profiles['claude-code'].turn0Tokens);

// 3. Preview progressive-disclosure file splitting
const splitPreview = await splitWorkspace({
  cwd: process.cwd(),
  target: 'claude',
  write: false,
});
console.log(splitPreview.proposedFiles);

// 4. Check cross-tool synchronization status
const syncStatus = await syncWorkspace({
  cwd: process.cwd(),
  from: 'claude',
  check: true,
});
console.log(syncStatus.inSync);
```

---

## GitHub Action

Deontic includes a GitHub Action (`packages/action/action.yml`) to gate pull requests on Harness File contradictions, dead references, context budget overflows, or cross-tool sync drift.

### Example Workflow (`.github/workflows/deontic.yml`)

```yaml
name: Deontic Lint

on:
  pull_request:
  push:
    branches: [main]

jobs:
  deontic:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Optional: enables git rename history lookup for CTX004

      - name: Run Deontic Static Analysis
        uses: thilak15/deontic/packages/action@main
        with:
          command: 'check'
          strict: 'true'
          format: 'github'
          working-directory: '.'
```

### Action Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `command` | `'check'` | Deontic command to run (`check` or `sync`). |
| `strict` | `'false'` | Fail the workflow step on warnings as well as errors (`true` or `false`). |
| `format` | `'github'` | Output reporter format (`github`, `sarif`, `json`, `pretty`). |
| `working-directory` | `'.'` | Repository directory to analyze. |

---

## Development

Run the following commands from the repository root:

```bash
# Install workspace dependencies
pnpm install

# Build all packages (@deontic/core, @deontic/cli, deontic-action)
pnpm build

# Run TypeScript typechecking across all packages
pnpm typecheck

# Run the Vitest test suite
pnpm test
```

---

## License

This project is licensed under the [MIT License](LICENSE).

