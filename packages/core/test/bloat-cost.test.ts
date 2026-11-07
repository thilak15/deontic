import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeWorkspace, profileWorkspaceCost } from '@deontic/core';
import { runCli } from '@deontic/cli';

const tempDirs: string[] = [];

function createTempWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-bloat-test-'));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Slice 1: Per-Agent Profile Budgeting (ADR-0002) & Context Notes vs Directives', () => {
  it('calculates token footprints and imperative Directive counts separately per Agent Profile and excludes descriptive Context Notes from Directive counts', async () => {
    const sharedContent = [
      '# Repository Overview',
      '',
      'This monorepo contains the billing and authentication services.',
      'The architecture follows hexagonal ports and adapters.',
      '',
      '## Coding Rules',
      '- Always use pnpm for package management.',
      '- Never commit secrets to the repository.',
      '- Prefer named exports across modules.',
    ].join('\n');

    const cwd = createTempWorkspace({
      'CLAUDE.md': sharedContent,
      '.claude/rules/api.md': [
        '---',
        'paths:',
        '  - "packages/api/**/*.ts"',
        '---',
        '# API Scoped Rules',
        'The API layer communicates with PostgreSQL.',
        '- Always validate request bodies with Zod.',
        '- Never mock the database in integration tests.',
      ].join('\n'),
      '.cursor/rules/global.mdc': [
        '---',
        'alwaysApply: true',
        '---',
        sharedContent,
      ].join('\n'),
      'AGENTS.md': sharedContent,
      'packages/billing/AGENTS.md': [
        '# Billing Rules',
        'Billing webhooks arrive from Stripe.',
        '- Must verify Stripe webhook signatures.',
      ].join('\n'),
      '.github/copilot-instructions.md': [
        '# Copilot Rules',
        'GitHub Copilot workspace instructions.',
        '- Always run tests before opening a pull request.',
      ].join('\n'),
    });

    const cost = await profileWorkspaceCost({ cwd });

    // 1. Verify each Agent Profile is budgeted independently (no cross-tool summing)
    const claude = cost.profiles['claude-code'];
    const cursor = cost.profiles.cursor;
    const codex = cost.profiles.codex;
    const copilot = cost.profiles.copilot;

    // CLAUDE.md has 3 imperative directives and 2 descriptive context notes at Turn 0
    // .claude/rules/api.md is path-scoped (isAlwaysLoadedAtRoot: false) with 2 directives and 1 context note
    expect(claude.files.map((f) => f.path)).toEqual(['.claude/rules/api.md', 'CLAUDE.md']);
    expect(claude.turn0Directives).toBe(3);
    expect(claude.totalDirectives).toBe(5);
    expect(claude.turn0Bytes).toBe(Buffer.byteLength(sharedContent, 'utf8'));
    expect(claude.turn0Tokens).toBeGreaterThan(20);
    expect(claude.totalTokens).toBeGreaterThan(claude.turn0Tokens);

    const claudeRootFile = claude.files.find((f) => f.path === 'CLAUDE.md')!;
    expect(claudeRootFile.directiveCount).toBe(3);
    expect(claudeRootFile.contextNoteCount).toBeGreaterThanOrEqual(2);
    expect(claudeRootFile.isAlwaysLoadedAtRoot).toBe(true);

    const claudeScopedFile = claude.files.find((f) => f.path === '.claude/rules/api.md')!;
    expect(claudeScopedFile.directiveCount).toBe(2);
    expect(claudeScopedFile.contextNoteCount).toBeGreaterThanOrEqual(1);
    expect(claudeScopedFile.isAlwaysLoadedAtRoot).toBe(false);

    // Cursor only has .cursor/rules/global.mdc (3 directives)
    expect(cursor.files.map((f) => f.path)).toEqual(['.cursor/rules/global.mdc']);
    expect(cursor.turn0Directives).toBe(3);
    expect(cursor.totalDirectives).toBe(3);

    // Codex has root AGENTS.md (Turn-0, 3 directives) and packages/billing/AGENTS.md (scoped, 1 directive)
    expect(codex.files.map((f) => f.path)).toEqual(['AGENTS.md', 'packages/billing/AGENTS.md']);
    expect(codex.turn0Directives).toBe(3);
    expect(codex.totalDirectives).toBe(4);
    // Root AGENTS.md and root CLAUDE.md have identical content, so their Turn-0 tokens and bytes match exactly
    expect(codex.turn0Tokens).toBe(claude.turn0Tokens);
    expect(codex.turn0Bytes).toBe(claude.turn0Bytes);

    // Copilot has .github/copilot-instructions.md (1 directive, 1 context note)
    expect(copilot.files.map((f) => f.path)).toEqual(['.github/copilot-instructions.md']);
    expect(copilot.turn0Directives).toBe(1);
    expect(copilot.totalDirectives).toBe(1);
  });
});

describe('Slice 2: CTX002 Silent-Truncation Cap (error >32 KiB) & Directive Adherence Cliff (warning >150 Directives)', () => {
  it('emits CTX002 error when Turn-0 byte payload exceeds 32 KiB and CTX002 warning when imperative Directives exceed 150 for a single Agent Profile', async () => {
    // 155 imperative directives for cursor (>150 cliff)
    const cursorDirectives = Array.from(
      { length: 155 },
      (_, i) => `- Always validate rule number ${i + 1} before committing.`,
    ).join('\n');

    // >32 KiB (33,500 bytes) payload for claude-code with descriptive context notes so only byte cap triggers on claude-code
    const longParagraph = 'This module handles background job processing and telemetry aggregation across worker nodes. ';
    const claudeOversized =
      '# Architecture Overview\n\n' +
      Array.from({ length: 400 }, (_, i) => `Section ${i + 1}: ${longParagraph}`).join('\n\n') +
      '\n\n## Rules\n- Always use pnpm.\n';

    expect(Buffer.byteLength(claudeOversized, 'utf8')).toBeGreaterThan(32768);

    const cwd = createTempWorkspace({
      'CLAUDE.md': claudeOversized,
      '.cursorrules': `# Cursor Rules\n${cursorDirectives}\n`,
    });

    const result = await analyzeWorkspace({ cwd });
    const ctx002 = result.diagnostics.filter((d) => d.code === 'CTX002');

    // 1. Claude Code should have a CTX002 error for exceeding 32 KiB (32768 bytes)
    const byteError = ctx002.find(
      (d) => d.severity === 'error' && d.agentProfile === 'claude-code',
    );
    expect(byteError).toBeDefined();
    expect(byteError?.primaryLocation.file).toBe('CLAUDE.md');
    expect(byteError?.message).toMatch(/32\s*KiB|32768/i);

    // 2. Cursor should have a CTX002 warning for exceeding 150 directives (155 > 150)
    const cliffWarn = ctx002.find(
      (d) => d.severity === 'warning' && d.agentProfile === 'cursor',
    );
    expect(cliffWarn).toBeDefined();
    expect(cliffWarn?.primaryLocation.file).toBe('.cursorrules');
    expect(cliffWarn?.message).toContain('155');
    expect(cliffWarn?.message).toContain('150');
  });

  it('does NOT double-count Directives across different Agent Profiles and does NOT count descriptive Context Notes toward the 150-Directive cliff', async () => {
    // 100 directives in CLAUDE.md, 100 in .cursorrules, 100 in AGENTS.md -> 300 across repo, but 100 per profile (<= 150)
    // Plus 80 descriptive Context Notes in CLAUDE.md (total 180 lines in CLAUDE.md, but only 100 imperative Directives)
    const makeDirectives = (count: number) =>
      Array.from({ length: count }, (_, i) => `- Must enforce invariant ${i + 1} in modules.`).join('\n');
    const makeNotes = (count: number) =>
      Array.from(
        { length: count },
        (_, i) => `Background note ${i + 1}: the billing service communicates over gRPC internally.`,
      ).join('\n\n');

    const cwd = createTempWorkspace({
      'CLAUDE.md': `# Claude\n\n${makeNotes(80)}\n\n## Constraints\n${makeDirectives(100)}\n`,
      '.cursorrules': `# Cursor\n${makeDirectives(100)}\n`,
      'AGENTS.md': `# Codex\n${makeDirectives(100)}\n`,
    });

    const result = await analyzeWorkspace({ cwd });
    const ctx002 = result.diagnostics.filter((d) => d.code === 'CTX002');
    expect(ctx002).toHaveLength(0);
  });
});


describe('Slice 3: Derivable Directory Tree Detection (CTX002) & deontic cost CLI', () => {
  it('detects both >= 8-line ASCII file trees and >= 10-item non-imperative path-catalog lists under CTX002 and reports wasted tokens in deontic cost', async () => {
    const asciiTree = [
      '```',
      'repo/',
      '├── package.json',
      '├── pnpm-workspace.yaml',
      '├── packages/',
      '│   ├── core/',
      '│   │   ├── src/index.ts',
      '│   │   └── package.json',
      '│   └── cli/',
      '│       ├── src/bin.ts',
      '│       └── package.json',
      '└── README.md',
      '```',
    ].join('\n');

    const pathCatalogList = [
      '- `src/auth/login.ts` — handles user login endpoints',
      '- `src/auth/logout.ts` — handles session revocation',
      '- `src/auth/tokens.ts` — signs and verifies JWTs',
      '- `src/billing/invoices.ts` — generates customer invoices',
      '- `src/billing/webhooks.ts` — processes Stripe events',
      '- `src/db/client.ts` — initializes Prisma client',
      '- `src/db/migrations/` — SQL migration history',
      '- `src/components/Button.tsx` — primary button component',
      '- `src/components/Modal.tsx` — dialog container',
      '- `src/utils/logger.ts` — structured JSON logger',
      '- `src/utils/env.ts` — environment schema',
    ].join('\n');

    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Project Structure',
        '',
        asciiTree,
        '',
        '## File Catalog',
        pathCatalogList,
        '',
        '## Actual Rules',
        '- Always use pnpm for package management.',
      ].join('\n'),
    });

    const checkRes = await analyzeWorkspace({ cwd });
    const ctx002 = checkRes.diagnostics.filter((d) => d.code === 'CTX002');
    expect(ctx002).toHaveLength(2);
    expect(ctx002.some((d) => d.message.includes('ASCII directory tree'))).toBe(true);
    expect(ctx002.some((d) => d.message.includes('path-catalog list'))).toBe(true);

    // Verify `deontic cost` CLI in pretty and json formats
    const cliPretty = await runCli(['cost'], { cwd });
    expect(cliPretty.exitCode).toBe(0);
    expect(cliPretty.stdout).toContain('Agent Profile: claude-code');
    expect(cliPretty.stdout).toContain('Derivable Directory Tree Waste:');
    expect(cliPretty.stdout).toContain('CLAUDE.md');

    const cliJson = await runCli(['cost', '--format', 'json'], { cwd });
    expect(cliJson.exitCode).toBe(0);
    const parsed = JSON.parse(cliJson.stdout);
    expect(parsed.profiles['claude-code'].wastedTreeTokens).toBeGreaterThan(30);
    expect(parsed.profiles['claude-code'].turn0Directives).toBe(1);
  });
});
