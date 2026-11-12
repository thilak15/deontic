import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeWorkspace,
  profileWorkspaceCost,
  splitWorkspace,
  syncWorkspace,
} from '../src/index.js';
import { runCli } from '../../cli/src/index.js';
import { runAction } from '../../action/src/index.js';

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-sync-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Ticket #8: Cross-Tool Rule Syncer, CI Reporters (sarif, github) & GitHub Action', () => {
  it('compiles .claude/rules/*.md and CLAUDE.md into .cursor/rules/*.mdc and AGENTS.md (pure directory globs -> subdir AGENTS.md, file-pattern globs -> marker blocks in longest common ancestor)', async () => {
    const cwd = createTempWorkspace();
    fs.mkdirSync(path.join(cwd, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'packages', 'api', 'src'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'packages', 'web', 'src'), { recursive: true });

    fs.writeFileSync(path.join(cwd, 'packages', 'api', 'src', 'index.ts'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'packages', 'web', 'src', 'app.test.ts'), 'export {};\n', 'utf8');

    // Root CLAUDE.md
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      `# Workspace Rules
- Always use pnpm for package management.
`,
      'utf8',
    );

    // Pure directory-scoped rule -> should compile to packages/api/AGENTS.md and .cursor/rules/api.mdc
    fs.writeFileSync(
      path.join(cwd, '.claude', 'rules', 'api.md'),
      `---
description: "API layer rules"
paths:
  - "packages/api/**"
---

# API Conventions
- Always use Vitest for backend API tests.
`,
      'utf8',
    );

    // Cross-cutting file-pattern glob -> should lower into root AGENTS.md with <!-- deontic:sync id="testing" globs="**/*.test.ts" -->
    fs.writeFileSync(
      path.join(cwd, '.claude', 'rules', 'testing.md'),
      `---
description: "Unit test rules"
paths:
  - "**/*.test.ts"
---

# Unit Test Rules
- Prefer named exports in test helpers.
`,
      'utf8',
    );

    // Subtree file-pattern glob -> longest common ancestor is packages/web -> packages/web/AGENTS.md
    fs.writeFileSync(
      path.join(cwd, '.claude', 'rules', 'web-components.md'),
      `---
description: "Web TSX component rules"
paths:
  - "packages/web/**/*.tsx"
---

# Web Component Rules
- Keep React components stateless where possible.
`,
      'utf8',
    );

    // 1. Before writing, `deontic sync --check` detects drift and exits 1
    const checkBefore = await runCli(['sync', '--check'], { cwd });
    expect(checkBefore.exitCode).toBe(1);
    expect(checkBefore.stdout).toContain('DRIFTED');

    // 2. Run `deontic sync --write`
    const syncRes = await syncWorkspace({ cwd, from: 'claude', write: true });
    expect(syncRes.written).toBe(true);
    expect(syncRes.inSync).toBe(true);

    // Verify generated .cursor/rules/*.mdc files
    expect(fs.existsSync(path.join(cwd, '.cursor', 'rules', 'api.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.cursor', 'rules', 'testing.mdc'))).toBe(true);
    const apiMdc = fs.readFileSync(path.join(cwd, '.cursor', 'rules', 'api.mdc'), 'utf8');
    expect(apiMdc).toContain('globs: packages/api/**');
    expect(apiMdc).toContain('alwaysApply: false');

    // Verify pure directory rule compiled into packages/api/AGENTS.md
    const apiAgentsMd = fs.readFileSync(path.join(cwd, 'packages', 'api', 'AGENTS.md'), 'utf8');
    expect(apiAgentsMd).toContain('<!-- deontic:sync id="api" globs="packages/api/**" -->');
    expect(apiAgentsMd).toContain('Always use Vitest for backend API tests.');

    // Verify cross-cutting file-pattern glob lowered into root AGENTS.md with marker comment
    const rootAgentsMd = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
    expect(rootAgentsMd).toContain('<!-- deontic:sync id="testing" globs="**/*.test.ts" -->');
    expect(rootAgentsMd).toContain('<!-- deontic:sync id="claude-md" globs="**/*" -->');

    // Verify subtree file-pattern glob lowered into longest common ancestor packages/web/AGENTS.md
    const webAgentsMd = fs.readFileSync(path.join(cwd, 'packages', 'web', 'AGENTS.md'), 'utf8');
    expect(webAgentsMd).toContain(
      '<!-- deontic:sync id="web-components" globs="packages/web/**/*.tsx" -->',
    );

    // 3. Running `deontic sync --check` now exits 0
    const checkAfter = await runCli(['sync', '--check'], { cwd });
    expect(checkAfter.exitCode).toBe(0);
    expect(checkAfter.stdout).toContain('All target Harness Files are in sync.');

    // 4. Synchronized workspace passes `deontic check` with zero false-positive CTX008 or CTX001 errors
    const analysis = await analyzeWorkspace({ cwd });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('supports --from cursor to compile .cursor/rules/*.mdc into .claude/rules/*.md and AGENTS.md', async () => {
    const cwd = createTempWorkspace();
    fs.mkdirSync(path.join(cwd, '.cursor', 'rules'), { recursive: true });

    fs.writeFileSync(
      path.join(cwd, '.cursor', 'rules', 'db.mdc'),
      `---
description: "Database rules"
globs: packages/db/**/*.ts
alwaysApply: false
---

# Database Rules
- Always use Prisma for database queries.
`,
      'utf8',
    );

    const res = await syncWorkspace({ cwd, from: 'cursor', write: true });
    expect(res.inSync).toBe(true);

    const claudeDbRule = fs.readFileSync(path.join(cwd, '.claude', 'rules', 'db.md'), 'utf8');
    expect(claudeDbRule).toContain('paths:');
    expect(claudeDbRule).toContain('"packages/db/**/*.ts"');
    expect(claudeDbRule).toContain('Always use Prisma for database queries.');

    const dbAgentsMd = fs.readFileSync(path.join(cwd, 'packages', 'db', 'AGENTS.md'), 'utf8');
    expect(dbAgentsMd).toContain('<!-- deontic:sync id="db" globs="packages/db/**/*.ts" -->');
  });

  it('formats valid SARIF 2.1.0 JSON (--format sarif), GitHub Actions annotations (--format github), and runs deontic-action', async () => {
    const cwd = createTempWorkspace();

    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      `# Rules
- Always use pnpm for package installs.
- Never use pnpm for package installs.
- Check \`src/missing-file.ts\` before deploying.
`,
      'utf8',
    );

    // 1. SARIF 2.1.0 output
    const sarifRes = await runCli(['check', '--format', 'sarif'], { cwd });
    expect(sarifRes.exitCode).toBe(1);
    const sarif = JSON.parse(sarifRes.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('deontic');
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(9);
    expect(sarif.runs[0].results.length).toBeGreaterThanOrEqual(2);
    const ctx001Result = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId === 'CTX001');
    expect(ctx001Result).toBeDefined();
    expect(ctx001Result.locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(ctx001Result.locations[0].physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);

    // 2. GitHub Actions workflow annotation output
    const ghRes = await runCli(['check', '--format', 'github'], { cwd });
    expect(ghRes.exitCode).toBe(1);
    expect(ghRes.stdout).toContain('::error file=CLAUDE.md,line=2,col=1,title=CTX001::');
    expect(ghRes.stdout).toContain('::error file=CLAUDE.md,line=4,col=10,title=CTX004::');

    // 3. GitHub Action wrapper (`deontic-action`)
    const actionCheck = await runAction({ command: 'check', format: 'github', cwd });
    expect(actionCheck.exitCode).toBe(1);
    expect(actionCheck.stdout).toContain('::error file=CLAUDE.md');

    const actionSync = await runAction({ command: 'sync', cwd });
    expect(actionSync.exitCode).toBe(1); // Drifted because sync hasn't been written yet
  });

  it('satisfies property-based (fast-check) round-trip idempotency for syncWorkspace and completes all 4 user journeys (check, cost, split, sync)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            slug: fc.constantFrom('api', 'auth', 'ui', 'testing'),
            dir: fc.constantFrom('packages/api/**', 'packages/web/**/*.tsx', '**/*.test.ts'),
            pkg: fc.constantFrom('pnpm', 'Vitest', 'Prisma'),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        async (items) => {
          const cwd = createTempWorkspace();
          fs.mkdirSync(path.join(cwd, '.claude', 'rules'), { recursive: true });

          const uniqueBySlug = new Map(items.map((item) => [item.slug, item]));
          for (const item of uniqueBySlug.values()) {
            fs.writeFileSync(
              path.join(cwd, '.claude', 'rules', `${item.slug}.md`),
              `---
description: "Rule ${item.slug}"
paths:
  - "${item.dir}"
---

# Section ${item.slug}
- Always use ${item.pkg} in ${item.slug}.
`,
              'utf8',
            );
          }

          const firstSync = await syncWorkspace({ cwd, from: 'claude', write: true });
          expect(firstSync.inSync).toBe(true);

          const snapshotAfterFirst = firstSync.targets.map((t) => ({
            path: t.path,
            disk: fs.readFileSync(path.join(cwd, t.path), 'utf8'),
          }));

          // Second sync must be 100% idempotent with zero drift
          const checkSecond = await syncWorkspace({ cwd, from: 'claude', check: true });
          expect(checkSecond.inSync).toBe(true);
          expect(checkSecond.targets.every((t) => !t.drifted)).toBe(true);

          const secondWrite = await syncWorkspace({ cwd, from: 'claude', write: true });
          const snapshotAfterSecond = secondWrite.targets.map((t) => ({
            path: t.path,
            disk: fs.readFileSync(path.join(cwd, t.path), 'utf8'),
          }));
          expect(snapshotAfterSecond).toEqual(snapshotAfterFirst);
        },
      ),
      { numRuns: 10 },
    );

    // End-to-End 4-Journey Verification (cost -> split -> sync -> check)
    const e2eCwd = createTempWorkspace();
    fs.mkdirSync(path.join(e2eCwd, 'packages', 'billing', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(e2eCwd, 'packages', 'billing', 'src', 'invoice.ts'),
      'export const invoice = true;\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(e2eCwd, 'CLAUDE.md'),
      `# General Standards
- Always use pnpm for package installs.

# Billing Service Rules
- Validate ` +
        '`packages/billing/src/invoice.ts`' +
        ` before charging customers.
- Never skip idempotency keys in ` +
        '`packages/billing/src/invoice.ts`' +
        `.
`,
      'utf8',
    );

    // Journey 1: Cost profiling before split
    const costBefore = await profileWorkspaceCost({ cwd: e2eCwd });
    expect(costBefore.profiles['claude-code'].turn0Tokens).toBeGreaterThan(0);

    // Journey 2: Progressive-disclosure auto-split
    const splitRes = await splitWorkspace({ cwd: e2eCwd, target: 'claude', write: true });
    expect(splitRes.proposedFiles.length).toBe(1);
    expect(splitRes.turn0TokensAfter).toBeLessThan(splitRes.turn0TokensBefore);

    // Journey 3: Cross-tool sync into Cursor & AGENTS.md
    const syncRes = await syncWorkspace({ cwd: e2eCwd, from: 'claude', write: true });
    expect(syncRes.inSync).toBe(true);

    // Journey 4: Final static check passes with 0 diagnostics
    const finalCheck = await analyzeWorkspace({ cwd: e2eCwd });
    expect(finalCheck.diagnostics).toEqual([]);
  });

  it('Ticket #14: folds warning groups (>3 per rule) and secondary locations (>5 per group) in default pretty mode, expands with --verbose, and prints the End-of-Run Summary Table', async () => {
    const cwd = createTempWorkspace();

    // Create a nested checkout boundary so excludedCheckouts is non-empty
    fs.mkdirSync(path.join(cwd, 'vendor', 'sub-repo', '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'vendor', 'sub-repo', 'CLAUDE.md'),
      '# Ignored sub-repo\n- Check `missing/subrepo.ts`.\n',
      'utf8',
    );

    // Create package.json so `pnpm test` is valid and `pnpm tset` is a fixable typo (CTX005)
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'test-pkg', scripts: { test: 'vitest run' } }, null, 2),
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');

    // Create >5 duplicate occurrences of one dead path (to test >5 secondary locations truncation)
    // plus a fixable CTX005 dead script, plus >3 distinct CTX008 warning groups
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      [
        '# Main Rules',
        '- Always use pnpm for package management.',
        '- Never use default exports in TypeScript modules.',
        '- Always use Vitest for unit testing.',
        '- Always use Prisma for database queries.',
        '- Run `pnpm tset` before committing.',
        '- Check `src/dead-target.ts` in step 1.',
        '- Check `src/dead-target.ts` in step 2.',
        '- Check `src/dead-target.ts` in step 3.',
        '- Check `src/dead-target.ts` in step 4.',
        '- Check `src/dead-target.ts` in step 5.',
        '- Check `src/dead-target.ts` in step 6.',
        '- Check `src/dead-target.ts` in step 7.',
      ].join('\n'),
      'utf8',
    );

    fs.mkdirSync(path.join(cwd, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'rules', 'dup.md'),
      [
        '# Duplicate Rules',
        '- Always use pnpm for package management.',
        '- Never use default exports in TypeScript modules.',
        '- Always use Vitest for unit testing.',
        '- Always use Prisma for database queries.',
      ].join('\n'),
      'utf8',
    );

    // 1. Default `deontic check` (--format pretty)
    const defaultRes = await runCli(['check'], { cwd });
    expect(defaultRes.exitCode).toBe(1);

    // Primary location renders code frame (`-->`), secondary locations render compact `:::` pointers
    expect(defaultRes.stdout).toContain('--> CLAUDE.md:');
    expect(defaultRes.stdout).toContain('::: CLAUDE.md:');

    // >5 secondary locations on `src/dead-target.ts` (7 total = 1 primary + 6 secondary -> 5 shown, 1 hidden)
    expect(defaultRes.stdout).toContain('... and 1 more location(s); pass --verbose to expand');

    // >3 CTX008 warning groups (4 total -> 3 shown, 1 hidden)
    expect(defaultRes.stdout).toMatch(
      /\.\.\. and 1 more CTX008 warning group\(s\) \[\d+ occurrences?\] hidden; pass --verbose to expand/,
    );

    // Structured End-of-Run Summary Table
    expect(defaultRes.stdout).toContain('Summary');
    expect(defaultRes.stdout).toContain('CTX004');
    expect(defaultRes.stdout).toContain('CTX005');
    expect(defaultRes.stdout).toContain('CTX008');
    expect(defaultRes.stdout).toContain('Grouped Issues');
    expect(defaultRes.stdout).toContain('Raw Occurrences');
    expect(defaultRes.stdout).toContain('vendor/sub-repo');
    expect(defaultRes.stdout).toContain('--fix');
    expect(defaultRes.stdout).toMatch(/Checked 2 harness file\(s\): 2 error\(s\), 4 warning\(s\)/);

    // 2. `deontic check --verbose` expands all warning groups and all secondary locations
    const verboseRes = await runCli(['check', '--verbose'], { cwd });
    expect(verboseRes.exitCode).toBe(1);
    expect(verboseRes.stdout).not.toContain('more location(s); pass --verbose to expand');
    expect(verboseRes.stdout).not.toContain('warning group(s)');
    expect(verboseRes.stdout).toContain('CLAUDE.md:13:');

    // 3. Machine-readable formats remain completely unfolded and include full summary & locations
    const jsonRes = await runCli(['check', '--format', 'json'], { cwd });
    const parsedJson = JSON.parse(jsonRes.stdout);
    expect(parsedJson.summary.groupedErrorCount).toBe(2);
    expect(parsedJson.summary.rawErrorCount).toBe(8);
    expect(parsedJson.summary.groupedWarningCount).toBe(4);
    expect(parsedJson.summary.excludedCheckouts).toEqual(['vendor/sub-repo']);
    const jsonCtx004 = parsedJson.diagnostics.find((d: { code: string }) => d.code === 'CTX004');
    expect(jsonCtx004.secondaryLocations).toHaveLength(6);

    const sarifRes = await runCli(['check', '--format', 'sarif'], { cwd });
    const parsedSarif = JSON.parse(sarifRes.stdout);
    expect(parsedSarif.runs[0].results).toHaveLength(6); // 2 errors + 4 warnings unfolded
    expect(parsedSarif.runs[0].properties.summary.rawErrorCount).toBe(8);

    const ghRes = await runCli(['check', '--format', 'github'], { cwd });
    expect(ghRes.stdout).toContain('::error file=CLAUDE.md,line=7,col=10,title=CTX004::');
    expect(ghRes.stdout).toContain('::error file=CLAUDE.md,line=13,col=10,title=CTX004::');
    expect(ghRes.stdout).toContain('::notice title=deontic-summary::grouped=2 error(s), 4 warning(s); raw=8 error(s), 4 warning(s)');
  });
});
