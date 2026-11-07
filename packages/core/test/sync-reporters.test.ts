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
});
