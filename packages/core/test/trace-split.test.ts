import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeWorkspace, correlateWorkspaceTraces, splitWorkspace } from '@deontic/core';
import { runCli } from '@deontic/cli';

const tempDirs: string[] = [];

function createTempWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-trace-split-'));
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

describe('Slice 1: Local Session Trace ROI Correlator (CTX009 & deontic trace)', () => {
  it('computes Session Hit Rate from tool calls & Bash commands, emits CTX009 for 0%-hit domain-specific root sections across >= 5 sessions, and ignores global sections', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Repository Guidelines',
        '',
        'This repository is a full-stack TypeScript monorepo.',
        '',
        '## Package Management & Workflow',
        '- Always use pnpm instead of npm.',
        '- Run `pnpm typecheck` before committing changes.',
        '',
        '## React UI Components',
        '- Keep all React components in `src/components/**` using `.tsx` files.',
        '- Prefer named exports for all UI components.',
        '',
        '## Database & Prisma Migrations',
        '- Keep schema definitions in `prisma/schema.prisma` and queries in `src/db/**`.',
        '- Always run `pnpm prisma migrate dev` when changing database tables.',
        '',
        '## Playwright E2E Testing',
        '- Place browser E2E tests in `e2e/**` with `*.spec.ts` extensions.',
        '- Run `npx playwright test` before releasing.',
      ].join('\n'),
      'src/components/Button.tsx': 'export const Button = () => null;\n',
      'src/components/Modal.tsx': 'export const Modal = () => null;\n',
      'src/db/client.ts': 'export const db = {};\n',
      'prisma/schema.prisma': 'datasource db { provider = "postgresql" }\n',
      'e2e/checkout.spec.ts': 'test("checkout", () => {});\n',
    });

    const traceDir = path.join(cwd, '.traces');
    fs.mkdirSync(traceDir, { recursive: true });

    // Create 5 session logs where:
    // - React UI Components is touched in 4/5 sessions (80% hit rate) via Read/Edit/Write/Grep
    // - Playwright E2E is touched in 1/5 sessions (20% hit rate) via Bash `npx playwright test`
    // - Database & Prisma Migrations is touched in 0/5 sessions (0% hit rate -> Dead Rule Section CTX009)
    // - Package Management & Workflow is universal/global -> never flagged as CTX009
    const sessions = [
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'src/components/Button.tsx') } },
            ],
          },
        }),
      ],
      [
        JSON.stringify({
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'src/components/Modal.tsx' },
        }),
      ],
      [
        JSON.stringify({
          tool: 'Write',
          input: { path: 'src/components/Card.tsx' },
        }),
      ],
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Grep', input: { path: 'src/components', pattern: 'Button' } },
              { type: 'tool_use', name: 'Bash', input: { command: 'npx playwright test e2e/checkout.spec.ts' } },
            ],
          },
        }),
      ],
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
            ],
          },
        }),
      ],
    ];

    sessions.forEach((lines, idx) => {
      fs.writeFileSync(path.join(traceDir, `session-${idx + 1}.jsonl`), lines.join('\n') + '\n', 'utf8');
    });

    const traceResult = await correlateWorkspaceTraces({ cwd, traceDir });
    expect(traceResult.sessionsAnalyzed).toBe(5);

    const byHeading = new Map(traceResult.sections.map((s) => [s.heading, s]));

    const globalSec = byHeading.get('Package Management & Workflow')!;
    expect(globalSec).toBeDefined();
    expect(globalSec.isDomainSpecific).toBe(false);
    expect(globalSec.isDeadRuleSection).toBe(false);

    const reactSec = byHeading.get('React UI Components')!;
    expect(reactSec).toBeDefined();
    expect(reactSec.isDomainSpecific).toBe(true);
    expect(reactSec.sessionsHit).toBe(4);
    expect(reactSec.sessionHitRate).toBe(80);
    expect(reactSec.isDeadRuleSection).toBe(false);

    const e2eSec = byHeading.get('Playwright E2E Testing')!;
    expect(e2eSec).toBeDefined();
    expect(e2eSec.isDomainSpecific).toBe(true);
    expect(e2eSec.sessionsHit).toBe(1);
    expect(e2eSec.sessionHitRate).toBe(20);
    expect(e2eSec.isDeadRuleSection).toBe(false);

    const dbSec = byHeading.get('Database & Prisma Migrations')!;
    expect(dbSec).toBeDefined();
    expect(dbSec.isDomainSpecific).toBe(true);
    expect(dbSec.sessionsHit).toBe(0);
    expect(dbSec.sessionHitRate).toBe(0);
    expect(dbSec.isDeadRuleSection).toBe(true);
    expect(dbSec.inferredGlobs).toEqual(expect.arrayContaining(['prisma/**', 'src/db/**']));

    // Exactly 1 CTX009 diagnostic for "Database & Prisma Migrations"
    expect(traceResult.diagnostics).toHaveLength(1);
    const diag = traceResult.diagnostics[0];
    expect(diag.code).toBe('CTX009');
    expect(diag.severity).toBe('warning');
    expect(diag.primaryLocation.file).toBe('CLAUDE.md');
    expect(diag.primaryLocation.lineStart).toBe(dbSec.lineStart);
    expect(diag.message).toContain('Database & Prisma Migrations');

    // Also verify Pass 6 of analyzeWorkspace emits CTX009 when traceDir is passed
    const checkResult = await analyzeWorkspace({ cwd, traceDir });
    const ctx009 = checkResult.diagnostics.filter((d) => d.code === 'CTX009');
    expect(ctx009).toHaveLength(1);
    expect(ctx009[0].message).toContain('Database & Prisma Migrations');

    // Verify CLI `deontic trace` in both pretty and json formats
    const cliPretty = await runCli(['trace', '--trace-dir', traceDir], { cwd });
    expect(cliPretty.exitCode).toBe(0);
    expect(cliPretty.stdout).toContain('Database & Prisma Migrations');
    expect(cliPretty.stdout).toContain('0%');
    expect(cliPretty.stdout).toContain('80%');

    const cliJson = await runCli(['trace', '--trace-dir', traceDir, '--format', 'json'], { cwd });
    expect(cliJson.exitCode).toBe(0);
    const parsed = JSON.parse(cliJson.stdout);
    expect(parsed.sessionsAnalyzed).toBe(5);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].code).toBe('CTX009');
  });

  it('auto-discovers ~/.claude/projects/<encoded-cwd>/*.jsonl and skips cleanly when no session logs exist', async () => {
    const fakeHome = createTempWorkspace({});
    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Root',
        '## Database Rules',
        '- Never modify `prisma/schema.prisma` without a migration.',
      ].join('\n'),
      'prisma/schema.prisma': 'model User { id Int @id }\n',
    });

    const prevHome = process.env.HOME;
    try {
      process.env.HOME = fakeHome;

      // 1. When no logs exist under ~/.claude/projects/<encoded-cwd>, skips cleanly with 0 warnings/errors
      const emptyRes = await correlateWorkspaceTraces({ cwd });
      expect(emptyRes.sessionsAnalyzed).toBe(0);
      expect(emptyRes.diagnostics).toHaveLength(0);

      // 2. Populate 5 sessions in ~/.claude/projects/<encoded-cwd>
      const encodedCwd = path.resolve(cwd).split(path.sep).join('-');
      const claudeProjectDir = path.join(fakeHome, '.claude', 'projects', encodedCwd);
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(claudeProjectDir, `s${i}.jsonl`),
          JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }) + '\n',
          'utf8',
        );
      }

      const foundRes = await correlateWorkspaceTraces({ cwd });
      expect(foundRes.sessionsAnalyzed).toBe(5);
      expect(foundRes.diagnostics).toHaveLength(1);
      expect(foundRes.diagnostics[0].code).toBe('CTX009');
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe('Slice 2: Progressive-Disclosure Auto-Splitter (deontic split)', () => {
  it('previews 3-Signal Path Inference in dry-run mode and writes lossless, idempotent path-scoped rule files with --write', async () => {
    const originalClaude = [
      '# Monolithic Project Instructions',
      '',
      'Welcome to the monorepo.',
      '',
      '## General & Git Workflow',
      '- Always use pnpm for package management.',
      '- Never force-push to main.',
      '',
      '## Database & Prisma Migrations',
      '- Keep schema definitions in `prisma/schema.prisma` and database helpers in `src/db/**`.',
      '- Never mock the database in integration tests.',
      '',
      '## Playwright E2E Testing',
      '- Place E2E tests in `e2e/**` with `*.spec.ts` extensions.',
      '- Always await Playwright locators.',
    ].join('\n');

    const cwd = createTempWorkspace({
      'CLAUDE.md': originalClaude,
      'prisma/schema.prisma': 'model User { id Int @id }\n',
      'src/db/index.ts': 'export const db = {};\n',
      'e2e/login.spec.ts': 'test("login", () => {});\n',
    });

    // 1. Dry-run by default: does not write files or modify CLAUDE.md
    const dryRun = await splitWorkspace({ cwd });
    expect(dryRun.written).toBe(false);
    expect(dryRun.proposedFiles).toHaveLength(2);
    expect(dryRun.reductionPercent).toBeGreaterThan(30);
    expect(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toBe(originalClaude);
    expect(fs.existsSync(path.join(cwd, '.claude/rules'))).toBe(false);

    // 2. Write mode via CLI `deontic split --write`
    const cliSplit = await runCli(['split', '--write'], { cwd });
    expect(cliSplit.exitCode).toBe(0);
    expect(cliSplit.stdout).toContain('WRITTEN');

    const prismaRulePath = path.join(cwd, '.claude/rules/database-prisma-migrations.md');
    const e2eRulePath = path.join(cwd, '.claude/rules/playwright-e2e-testing.md');
    expect(fs.existsSync(prismaRulePath)).toBe(true);
    expect(fs.existsSync(e2eRulePath)).toBe(true);

    const prismaContent = fs.readFileSync(prismaRulePath, 'utf8');
    expect(prismaContent).toContain('paths:');
    expect(prismaContent).toContain('prisma/**');
    expect(prismaContent).toContain('src/db/**');
    expect(prismaContent).toContain('Never mock the database in integration tests.');

    const trimmedClaude = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(trimmedClaude).toContain('General & Git Workflow');
    expect(trimmedClaude).not.toContain('Database & Prisma Migrations');
    expect(trimmedClaude).not.toContain('Playwright E2E Testing');

    // 3. Running split --write a second time is idempotent
    const secondSplit = await splitWorkspace({ cwd, write: true });
    expect(secondSplit.proposedFiles).toHaveLength(0);
    expect(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toBe(trimmedClaude);
  });

  it('supports --target cursor by emitting .cursor/rules/*.mdc files with globs and alwaysApply: false', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Root',
        '## General',
        '- Always use pnpm.',
        '## React UI Components',
        '- Place components in `src/components/**` using `.tsx`.',
      ].join('\n'),
      'src/components/Button.tsx': 'export const Button = () => null;\n',
    });

    const res = await splitWorkspace({ cwd, target: 'cursor', write: true });
    expect(res.written).toBe(true);
    expect(res.proposedFiles).toHaveLength(1);
    expect(res.proposedFiles[0].targetPath).toBe('.cursor/rules/react-ui-components.mdc');
    const mdcContent = fs.readFileSync(path.join(cwd, '.cursor/rules/react-ui-components.mdc'), 'utf8');
    expect(mdcContent).toContain('globs:');
    expect(mdcContent).toContain('alwaysApply: false');
    expect(mdcContent).toContain('src/components/**');
  });
});
