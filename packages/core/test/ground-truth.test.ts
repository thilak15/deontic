import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeWorkspace } from '@deontic/core';
import { runCli } from '@deontic/cli';

const tempDirs: string[] = [];

function createTempWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-ground-truth-'));
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

describe('Slice 1: CTX004 Dead Reference Detection & Four Deterministic False-Positive Guards', () => {
  it('flags confirmed missing paths while suppressing Negated/Deprecated, Template, Lexical (@scope/pkg, URLs, MIME, git refs), and Build-Output paths', async () => {
    const cwd = createTempWorkspace({
      '.gitignore': 'coverage/\ncustom-out/\n',
      'package.json': JSON.stringify(
        {
          name: 'test-repo',
          dependencies: {
            '@tanstack/react-query': '^5.0.0',
          },
          devDependencies: {
            '@total-typescript/shoehorn': '^1.0.0',
          },
          scripts: {
            'test:unit': 'vitest run',
          },
        },
        null,
        2,
      ),
      'src/existing.ts': 'export const ok = 1;\n',
      'CLAUDE.md': [
        '# Ground Truth Rules',
        '- Keep entry logic in `src/existing.ts`.',
        '- See `src/missing-service.ts` for webhook verification.',
        '- NEVER import from `src/legacy/deleted-auth.ts` (removed in v2).',
        '- Place new feature modules in `src/features/<feature-name>/index.ts` or `src/modules/{module}/service.ts` or `src/example/foo/bar.ts`.',
        '- Place Next.js dynamic routes in `src/app/[slug]/page.tsx`.',
        '- Use `@tanstack/react-query` for data fetching and `@total-typescript/shoehorn` in tests.',
        '- Return `application/json` from `/api/v1/health` and rebase onto `origin/main`.',
        '- Compiled bundles are emitted to `dist/cli.mjs` and `custom-out/bundle.js`.',
      ].join('\n'),
    });

    const result = await analyzeWorkspace({ cwd });
    const ctx004 = result.diagnostics.filter((d) => d.code === 'CTX004');

    // Only `src/missing-service.ts` should be flagged!
    expect(ctx004).toHaveLength(1);
    expect(ctx004[0].severity).toBe('error');
    expect(ctx004[0].message).toContain('src/missing-service.ts');
    expect(ctx004[0].primaryLocation.file).toBe('CLAUDE.md');
    expect(ctx004[0].primaryLocation.lineStart).toBe(3);
  });
});

describe('Slice 2: Git Rename Resolution (Tier 1) & Unique Suffix Fallback (Tier 2) + check --fix', () => {
  it('resolves git renamed files with commit SHA (Tier 1) and unique basename/suffix moves (Tier 2), and rewrites them via check --fix', async () => {
    const cwd = createTempWorkspace({
      'packages/api/src/trpc.ts': 'export const appRouter = {};\n',
      'packages/auth/src/middleware/auth.ts': 'export const authMiddleware = {};\n',
      'CLAUDE.md': [
        '# Architecture',
        '- See `packages/api/src/trpc.ts` for context creation.',
        '- Auth middleware lives in `src/middleware/auth.ts`.',
      ].join('\n'),
    });

    // Initialize git repo, commit trpc.ts, then git mv trpc.ts -> router.ts
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['mv', 'packages/api/src/trpc.ts', 'packages/api/src/router.ts'], {
      cwd,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'refactor: rename trpc to router'], {
      cwd,
      stdio: 'ignore',
    });

    const beforeFix = await analyzeWorkspace({ cwd });
    const ctx004 = beforeFix.diagnostics.filter((d) => d.code === 'CTX004');
    expect(ctx004).toHaveLength(2);

    const trpcDiag = ctx004.find((d) => d.message.includes('packages/api/src/trpc.ts'))!;
    expect(trpcDiag).toBeDefined();
    expect(trpcDiag.help).toMatch(/renamed to 'packages\/api\/src\/router\.ts' in commit [0-9a-f]+/i);

    const authDiag = ctx004.find((d) => d.message.includes('src/middleware/auth.ts'))!;
    expect(authDiag).toBeDefined();
    expect(authDiag.help).toContain('packages/auth/src/middleware/auth.ts');

    // Run `deontic check --fix`
    const cliFix = await runCli(['check', '--fix'], { cwd });
    expect(cliFix.exitCode).toBe(0);

    const updatedClaude = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(updatedClaude).toContain('packages/api/src/router.ts');
    expect(updatedClaude).toContain('packages/auth/src/middleware/auth.ts');
    expect(updatedClaude).not.toContain('packages/api/src/trpc.ts');

    // Re-running analyzeWorkspace produces 0 CTX004 diagnostics
    const afterFix = await analyzeWorkspace({ cwd });
    expect(afterFix.diagnostics.filter((d) => d.code === 'CTX004')).toHaveLength(0);
  });
});

describe('Slice 3: CTX005 Dead Script & Makefile Target Verification + check --fix', () => {
  it('flags missing package.json scripts and Makefile targets with edit-distance suggestions and auto-fixes unambiguous typos', async () => {
    const cwd = createTempWorkspace({
      'package.json': JSON.stringify(
        {
          name: 'monorepo',
          scripts: {
            'test:unit': 'vitest run',
            build: 'tsup',
            typecheck: 'tsc --noEmit',
          },
        },
        null,
        2,
      ),
      Makefile: [
        '.PHONY: deploy-staging build-image',
        'deploy-staging:',
        '\t@echo deploying',
        'build-image:',
        '\t@echo building',
      ].join('\n'),
      'CLAUDE.md': [
        '# Commands',
        '- Always run `pnpm install` and `pnpm build` first.',
        '- Run `pnpm run test:unit:watch` before committing.',
        '- Run `make deploy-stagin` to deploy to staging.',
      ].join('\n'),
    });

    const beforeFix = await analyzeWorkspace({ cwd });
    const ctx005 = beforeFix.diagnostics.filter((d) => d.code === 'CTX005');
    expect(ctx005).toHaveLength(2);

    const npmDiag = ctx005.find((d) => d.message.includes('test:unit:watch'))!;
    expect(npmDiag).toBeDefined();
    expect(npmDiag.help).toContain('test:unit');
    expect(npmDiag.fix).toBeDefined();

    const makeDiag = ctx005.find((d) => d.message.includes('deploy-stagin'))!;
    expect(makeDiag).toBeDefined();
    expect(makeDiag.help).toContain('deploy-staging');
    expect(makeDiag.fix).toBeDefined();

    // Auto-fix both via `deontic check --fix`
    const cliFix = await runCli(['check', '--fix'], { cwd });
    expect(cliFix.exitCode).toBe(0);

    const updated = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(updated).toContain('pnpm run test:unit');
    expect(updated).not.toContain('test:unit:watch');
    expect(updated).toContain('make deploy-staging');

    const afterFix = await analyzeWorkspace({ cwd });
    expect(afterFix.diagnostics.filter((d) => d.code === 'CTX005')).toHaveLength(0);
  });
});

describe('Slice 4: Diagnostic Group Consolidation for Repeated CTX003, CTX004, CTX005 & Summary Counts', () => {
  it('consolidates repeated dead path (CTX004), dead script (CTX005), and child override (CTX003) occurrences into single Diagnostic Groups with merged --fix edits and summary counts', async () => {
    const cwd = createTempWorkspace({
      'package.json': JSON.stringify(
        {
          name: 'monorepo',
          scripts: {
            'test:unit': 'vitest run',
          },
        },
        null,
        2,
      ),
      'packages/auth/src/middleware/auth.ts': 'export const auth = 1;\n',
      'packages/api/src/router.ts': 'export default function api() {}\n',
      'packages/web/src/page.tsx': 'export default function Page() {}\n',
      'CLAUDE.md': [
        '# Root Rules',
        '- Never use default exports in TypeScript files.',
        '- Auth logic lives in `src/middleware/auth.ts`.',
        '- Run `pnpm run test:unit:watch` locally.',
      ].join('\n'),
      'AGENTS.md': [
        '# Root Agents',
        '- Verify `src/middleware/auth.ts` before changing sessions.',
        '- Always run `pnpm run test:unit:watch` in CI.',
      ].join('\n'),
      'packages/api/AGENTS.md': [
        '# API Rules',
        '- Must use default exports in route handlers.',
        '- Import `src/middleware/auth.ts` for auth checks.',
      ].join('\n'),
      'packages/web/AGENTS.md': [
        '# Web Rules',
        '- Must use default exports in Next.js pages.',
      ].join('\n'),
    });

    const beforeFix = await analyzeWorkspace({ cwd });

    // 1. CTX004: `src/middleware/auth.ts` is referenced in 3 files -> consolidated into 1 Diagnostic Group with rawOccurrenceCount = 3
    const ctx004 = beforeFix.diagnostics.filter((d) => d.code === 'CTX004');
    expect(ctx004).toHaveLength(1);
    expect(ctx004[0].rawOccurrenceCount).toBe(3);
    expect(ctx004[0].secondaryLocations).toHaveLength(2);
    expect(ctx004[0].fix?.edits).toHaveLength(3);

    // 2. CTX005: `pnpm run test:unit:watch` is referenced in 2 files -> consolidated into 1 Diagnostic Group with rawOccurrenceCount = 2
    const ctx005 = beforeFix.diagnostics.filter((d) => d.code === 'CTX005');
    expect(ctx005).toHaveLength(1);
    expect(ctx005[0].rawOccurrenceCount).toBe(2);
    expect(ctx005[0].secondaryLocations).toHaveLength(1);
    expect(ctx005[0].fix?.edits).toHaveLength(2);

    // 3. CTX003: `CLAUDE.md` default-export rule is overridden by both packages/api/AGENTS.md and packages/web/AGENTS.md -> 1 Diagnostic Group with rawOccurrenceCount = 2
    const ctx003 = beforeFix.diagnostics.filter((d) => d.code === 'CTX003');
    expect(ctx003).toHaveLength(1);
    expect(ctx003[0].rawOccurrenceCount).toBe(2);
    expect(ctx003[0].secondaryLocations).toHaveLength(2);
    expect(ctx003[0].fix).toBeDefined();

    // 4. Verify WorkspaceAnalysisResult.summary distinguishes Grouped Issues vs Raw Occurrences
    expect(beforeFix.summary).toBeDefined();
    expect(beforeFix.summary?.groupedErrorCount).toBe(2); // 1 CTX004 group + 1 CTX005 group
    expect(beforeFix.summary?.rawErrorCount).toBe(5); // 3 CTX004 occurrences + 2 CTX005 occurrences
    expect(beforeFix.summary?.groupedWarningCount).toBe(1); // 1 CTX003 group
    expect(beforeFix.summary?.rawWarningCount).toBe(2); // 2 CTX003 child overrides
    expect(beforeFix.summary?.fixableCount).toBe(3);

    // 5. Running `deontic check --fix` heals all 3 groups (all 7 raw occurrences) in a single pass!
    const cliFix = await runCli(['check', '--fix'], { cwd });
    expect(cliFix.exitCode).toBe(0);

    const afterFix = await analyzeWorkspace({ cwd });
    expect(afterFix.diagnostics).toHaveLength(0);
    expect(afterFix.summary?.groupedErrorCount).toBe(0);
    expect(afterFix.summary?.rawErrorCount).toBe(0);
  });
});

