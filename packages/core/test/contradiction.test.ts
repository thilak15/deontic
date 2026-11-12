import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeWorkspace } from '@deontic/core';
import { runCli } from '@deontic/cli';

const tempDirs: string[] = [];

function createTempWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-contradiction-test-'));
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

describe('Slice 1: Two-Tier Witness-Based Glob Intersection (ADR-0003) & Basic CTX001', () => {
  it('selects the shortest real repository file as Witness Path in Tier 1 and falls back to synthetic path in Tier 2', async () => {
    const cwdTier1 = createTempWorkspace({
      'CLAUDE.md': '# Root Claude\n- Always use pnpm.\n',
      'AGENTS.md': '# Root Agents\n- Never use pnpm.\n',
      'packages/api/src/router.ts': 'export const r = 1;\n',
      'packages/api/src/controllers/user-profile-controller.ts': 'export const u = 2;\n',
    });

    const resTier1 = await analyzeWorkspace({ cwd: cwdTier1 });
    const ctx001Tier1 = resTier1.diagnostics.filter((d) => d.code === 'CTX001');
    expect(ctx001Tier1).toHaveLength(1);
    expect(ctx001Tier1[0].severity).toBe('error');
    expect(ctx001Tier1[0].witnessPath).toBe('packages/api/src/router.ts');
    expect(ctx001Tier1[0].secondaryLocations).toHaveLength(1);

    const cwdTier2 = createTempWorkspace({
      '.claude/rules/future-api.md': [
        '---',
        'paths:',
        '  - "packages/uncreated-service/**/*.ts"',
        '---',
        '# Future API',
        '- Always mock the database.',
      ].join('\n'),
      '.cursor/rules/future-tests.mdc': [
        '---',
        'globs: ["packages/uncreated-service/**/*.test.ts"]',
        'alwaysApply: false',
        '---',
        '# Future Tests',
        '- Never mock the database.',
      ].join('\n'),
      'packages/existing/index.ts': 'export const ok = true;\n',
    });

    const resTier2 = await analyzeWorkspace({ cwd: cwdTier2 });
    const ctx001Tier2 = resTier2.diagnostics.filter((d) => d.code === 'CTX001');
    expect(ctx001Tier2).toHaveLength(1);
    expect(ctx001Tier2[0].witnessPath).toBeDefined();
    expect(ctx001Tier2[0].witnessPath).toMatch(/^packages\/uncreated-service\/.*\.test\.ts$/);
  });

  it('respects negated globs (!packages/legacy/**) so disjoint scopes produce zero contradictions', async () => {
    const cwd = createTempWorkspace({
      '.claude/rules/modern.md': [
        '---',
        'paths:',
        '  - "**/*"',
        '  - "!packages/legacy/**"',
        '---',
        '# Modern Rules',
        '- Always use ESM.',
      ].join('\n'),
      '.claude/rules/legacy.md': [
        '---',
        'paths:',
        '  - "packages/legacy/**"',
        '---',
        '# Legacy Rules',
        '- Never use ESM.',
      ].join('\n'),
      'packages/modern/index.ts': 'export const m = 1;\n',
      'packages/legacy/index.ts': 'module.exports = {};\n',
    });

    const res = await analyzeWorkspace({ cwd });
    expect(res.diagnostics.filter((d) => d.code === 'CTX001' || d.code === 'CTX003')).toHaveLength(0);
  });
});

describe('Slice 2: Canonical Domain Ontology — Subtypes, Entailments, Exclusivity & Modality Severity (ADR-0001)', () => {
  it('resolves Prisma ⊑ database hyponymy and Testcontainers ⇒ Docker entailment in compound sentences', async () => {
    const cwd = createTempWorkspace({
      '.claude/rules/testing-a.md': [
        '---',
        'paths: ["packages/billing/**"]',
        '---',
        '# Billing Integration',
        '- Never mock the database; always use Testcontainers.',
      ].join('\n'),
      '.cursor/rules/testing-b.mdc': [
        '---',
        'globs: ["packages/billing/**"]',
        'alwaysApply: false',
        '---',
        '# Billing Unit Rules',
        '- Unit tests must run in less than 50ms with zero Docker dependencies; mock all Prisma calls.',
      ].join('\n'),
      'packages/billing/src/invoice.test.ts': 'export const test = 1;\n',
    });

    const res = await analyzeWorkspace({ cwd });
    const ctx001 = res.diagnostics.filter((d) => d.code === 'CTX001');
    expect(ctx001.length).toBeGreaterThanOrEqual(2);
    expect(ctx001.every((d) => d.severity === 'error')).toBe(true);
    expect(ctx001.every((d) => d.witnessPath === 'packages/billing/src/invoice.test.ts')).toBe(true);
  });

  it('flags single-choice mutual exclusion (pnpm vs npm, vitest vs jest, default vs named export) and treats SHOULD conflicts as warnings', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Root',
        '- Always use pnpm for package management.',
        '- Prefer named exports in all modules.',
      ].join('\n'),
      'AGENTS.md': [
        '# Root Agents',
        '- Always use npm for package management.',
        '- Must use default exports in all modules.',
      ].join('\n'),
      'src/index.ts': 'export const x = 1;\n',
    });

    const res = await analyzeWorkspace({ cwd });
    const ctx001 = res.diagnostics.filter((d) => d.code === 'CTX001');
    expect(ctx001).toHaveLength(2);

    const pkgConflict = ctx001.find((d) => d.message.includes('package_manager'));
    expect(pkgConflict?.severity).toBe('error');

    const exportConflict = ctx001.find((d) => d.message.includes('export_style'));
    expect(exportConflict?.severity).toBe('warning');
  });
});

describe('Slice 3: Unscoped Ancestor Overrides (CTX003) & Idempotent check --fix', () => {
  it('emits CTX003 warning when a child Harness File reverses an always-loaded root rule and fixes it idempotently via check --fix', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': '# Root Rules\n- Never use default exports in TypeScript files.\n',
      'packages/api/AGENTS.md': '# API Rules\n- All Next.js route handlers and page components MUST use default exports.\n',
      'packages/api/src/router.ts': 'export default function handler() {}\n',
    });

    const beforeFix = await analyzeWorkspace({ cwd });
    const ctx003 = beforeFix.diagnostics.filter((d) => d.code === 'CTX003');
    expect(ctx003).toHaveLength(1);
    expect(ctx003[0].severity).toBe('warning');
    expect(ctx003[0].witnessPath).toBe('packages/api/src/router.ts');
    expect(ctx003[0].fix).toBeDefined();

    // Run CLI `deontic check --fix`
    const cliFix = await runCli(['check', '--fix'], { cwd });
    expect(cliFix.exitCode).toBe(0);

    const updatedRoot = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(updatedRoot).toContain('except in packages/api/**');

    // Re-running analyzeWorkspace after --fix produces 0 CTX003 and 0 CTX001 diagnostics
    const afterFix = await analyzeWorkspace({ cwd });
    expect(afterFix.diagnostics.filter((d) => d.code === 'CTX003' || d.code === 'CTX001')).toHaveLength(0);

    // Running --fix a second time is idempotent
    const secondFix = await analyzeWorkspace({ cwd, fix: true });
    expect(secondFix.appliedFixes).toHaveLength(0);
    expect(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toBe(updatedRoot);
  });
});

describe('Slice 4: Same-Agent-Profile Redundancy (CTX008) vs Cross-Profile Isolation (ADR-0002)', () => {
  it('emits CTX008 for duplicate Directives within the same Agent Profile but never across different Agent Profiles', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': '# Root Claude\n- Always use pnpm for package management.\n',
      '.claude/rules/workflow.md': '# Claude Workflow\n- Always use pnpm as the package manager.\n',
      'AGENTS.md': '# Codex Agents\n- Always use pnpm for package management.\n',
      '.cursor/rules/pkg.mdc': '---\nalwaysApply: true\n---\n# Cursor\n- Always use pnpm for package management.\n',
      'src/index.ts': 'export const a = 1;\n',
    });

    const res = await analyzeWorkspace({ cwd });
    const ctx008 = res.diagnostics.filter((d) => d.code === 'CTX008');
    // Only CLAUDE.md + .claude/rules/workflow.md share Agent Profile 'claude-code'
    expect(ctx008).toHaveLength(1);
    expect(ctx008[0].severity).toBe('warning');
    expect(ctx008[0].agentProfile).toBe('claude-code');
    expect(ctx008[0].primaryLocation.file).toBe('.claude/rules/workflow.md');
  });

  it('exempts on-demand SKILL.md files and distinct workflow/domain sections in the same file from CTX008, while consolidating k >= 3 duplicates into 1 Diagnostic Group with rawOccurrenceCount', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Overview',
        '- Always run `pnpm test` before opening a pull request.',
        '',
        '## General Rules',
        '- Always use pnpm for package management.',
        '- Always use pnpm as the package manager.',
        '',
        '## PR & Release Checklist',
        '- Always run `pnpm test` before opening a pull request.',
      ].join('\n'),
      '.claude/rules/a.md': '# Rule A\n- Always use pnpm for package management.\n',
      '.claude/rules/b.md': '# Rule B\n- Always use pnpm for package management.\n',
      // On-demand skill (alwaysApply not true) repeating the same directive -> MUST NOT be flagged
      '.claude/skills/deploy/SKILL.md': '# Deploy Skill\n- Always use pnpm for package management.\n- Always run `pnpm test` before opening a pull request.\n',
      'src/index.ts': 'export const a = 1;\n',
    });

    const res = await analyzeWorkspace({ cwd });
    const ctx008 = res.diagnostics.filter((d) => d.code === 'CTX008');

    // 1. On-demand SKILL.md and Overview vs PR Checklist cross-section reminder produce 0 false positives.
    // 2. The 4 pnpm directives (2 in CLAUDE.md##General Rules + .claude/rules/a.md + .claude/rules/b.md)
    //    are consolidated into a SINGLE Diagnostic Group instead of C(4,2) = 6 pairwise warnings!
    expect(ctx008).toHaveLength(1);
    const group = ctx008[0];
    expect(group.rawOccurrenceCount).toBe(6);
    // 1 primary duplicate + 1 original + 2 remaining duplicates = 3 secondaryLocations
    expect(group.secondaryLocations).toHaveLength(3);
    expect(
      [group.primaryLocation.file, ...(group.secondaryLocations ?? []).map((s) => s.file)].every(
        (f) => !f.includes('SKILL.md'),
      ),
    ).toBe(true);

    // 3. A SKILL.md with `alwaysApply: true` IS part of Turn-0 Load and IS included in CTX008
    const cwdAlwaysSkill = createTempWorkspace({
      'CLAUDE.md': '# Root\n- Always use pnpm for package management.\n',
      '.claude/skills/always/SKILL.md':
        '---\nalwaysApply: true\n---\n# Always Skill\n- Always use pnpm for package management.\n',
      'src/index.ts': 'export const a = 1;\n',
    });
    const resAlwaysSkill = await analyzeWorkspace({ cwd: cwdAlwaysSkill });
    const ctx008Always = resAlwaysSkill.diagnostics.filter((d) => d.code === 'CTX008');
    expect(ctx008Always).toHaveLength(1);
    expect(ctx008Always[0].primaryLocation.file).toBe('.claude/skills/always/SKILL.md');

    // 4. CTX001: 1 root Directive conflicting with 2 peer Directives on the same topic consolidates into 1 Diagnostic Group with rawOccurrenceCount = 2
    const cwdCtx001Group = createTempWorkspace({
      'CLAUDE.md': '# Root Claude\n- Always use pnpm for package management.\n',
      'AGENTS.md': '# Codex Agents\n- Never use pnpm for package management.\n',
      '.cursor/rules/pkg.mdc':
        '---\nalwaysApply: true\n---\n# Cursor\n- Always use npm for package management.\n',
      'src/index.ts': 'export const a = 1;\n',
    });
    const resCtx001Group = await analyzeWorkspace({ cwd: cwdCtx001Group });
    const ctx001 = resCtx001Group.diagnostics.filter((d) => d.code === 'CTX001');
    expect(ctx001).toHaveLength(1);
    expect(ctx001[0].rawOccurrenceCount).toBe(2);
    expect(ctx001[0].secondaryLocations).toHaveLength(2);
  });
});

describe('Slice 5: Property-Based Tests (fast-check) for Solver & Scope Invariants', () => {
  it('satisfies symmetry, irreflexivity (zero self-contradiction), and disjoint-scope isolation', async () => {
    const pkgManagers = ['pnpm', 'npm', 'yarn', 'bun'] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...pkgManagers),
        fc.constantFrom(...pkgManagers),
        fc.boolean(),
        async (pkgA, pkgB, negateB) => {
          const ruleA = `- Always use ${pkgA}.`;
          const ruleB = negateB ? `- Never use ${pkgB}.` : `- Always use ${pkgB}.`;

          // 1. Irreflexivity: identical directive in two scopes never contradicts itself
          if (ruleA === ruleB) {
            const selfDir = createTempWorkspace({
              'CLAUDE.md': `# A\n${ruleA}\n`,
              'AGENTS.md': `# B\n${ruleA}\n`,
              'src/index.ts': 'export const x = 1;\n',
            });
            const selfRes = await analyzeWorkspace({ cwd: selfDir });
            expect(selfRes.diagnostics.filter((d) => d.code === 'CTX001' || d.code === 'CTX003')).toHaveLength(0);
          }

          // 2. Symmetry: contradicts(A, B) <=> contradicts(B, A)
          const dirAB = createTempWorkspace({
            'CLAUDE.md': `# A\n${ruleA}\n`,
            'AGENTS.md': `# B\n${ruleB}\n`,
            'src/index.ts': 'export const x = 1;\n',
          });
          const dirBA = createTempWorkspace({
            'CLAUDE.md': `# B\n${ruleB}\n`,
            'AGENTS.md': `# A\n${ruleA}\n`,
            'src/index.ts': 'export const x = 1;\n',
          });
          const resAB = await analyzeWorkspace({ cwd: dirAB });
          const resBA = await analyzeWorkspace({ cwd: dirBA });
          const countAB = resAB.diagnostics.filter((d) => d.code === 'CTX001').length;
          const countBA = resBA.diagnostics.filter((d) => d.code === 'CTX001').length;
          expect(countAB).toBe(countBA);

          // 3. Disjoint-scope isolation: packages/a/** vs packages/b/** never contradict
          const dirDisjoint = createTempWorkspace({
            '.claude/rules/a.md': `---\npaths: ["packages/a/**"]\n---\n# A\n${ruleA}\n`,
            '.claude/rules/b.md': `---\npaths: ["packages/b/**"]\n---\n# B\n${ruleB}\n`,
            'packages/a/index.ts': 'export const a = 1;\n',
            'packages/b/index.ts': 'export const b = 2;\n',
          });
          const resDisjoint = await analyzeWorkspace({ cwd: dirDisjoint });
          expect(
            resDisjoint.diagnostics.filter((d) => d.code === 'CTX001' || d.code === 'CTX003'),
          ).toHaveLength(0);
        },
      ),
      { numRuns: 16 },
    );
  });
});
