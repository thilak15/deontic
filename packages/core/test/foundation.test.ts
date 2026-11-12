import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeWorkspace } from '@deontic/core';
import { runCli } from '@deontic/cli';

const tempDirs: string[] = [];

function createTempWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-test-'));
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

describe('Slice 1: Harness File Discovery, Agent Profiles & Effective Scope', () => {
  it('discovers Harness Files across supported tools while respecting .gitignore and allowing hidden harness dirs', async () => {
    const cwd = createTempWorkspace({
      '.gitignore': 'dist/\nignored-dir/\n',
      'CLAUDE.md': '# Root Claude\n- Always use pnpm.\n',
      'CLAUDE.local.md': '# Local Claude\n- Prefer vitest.\n',
      '.claude/rules/api.md': '---\npaths:\n  - "packages/api/**/*.ts"\n---\n# API Rule\n- Never mock the database.\n',
      '.claude/skills/review/SKILL.md': '# Review Skill\n- Always run tests.\n',
      '.cursor/rules/frontend.mdc': '---\nglobs: ["packages/web/**/*.tsx"]\nalwaysApply: false\n---\n# Web Rule\n- Use Tailwind.\n',
      '.cursorrules': 'Always use strict TypeScript.\n',
      'AGENTS.md': '# Root Agents\n- Always run typecheck.\n',
      'packages/billing/AGENTS.md': '# Billing Agents\n- Must validate webhooks.\n',
      'GEMINI.md': '# Gemini\n- Use ESM.\n',
      '.windsurfrules': 'Prefer named exports.\n',
      '.github/copilot-instructions.md': '# Copilot\n- Never commit secrets.\n',
      '.github/instructions/tests.instructions.md': '---\napplyTo: "**/*.test.ts"\n---\n# Test Instructions\n- Use vitest.\n',
      '.mcp.json': '{"mcpServers": {}}',
      'dist/CLAUDE.md': '# Should be ignored by .gitignore\n',
      'ignored-dir/AGENTS.md': '# Should be ignored by .gitignore\n',
      'packages/api/src/index.ts': 'export const ok = true;\n',
    });

    const result = await analyzeWorkspace({ cwd });
    const discoveredPaths = result.harnessFiles.map((f) => f.path).sort();

    expect(discoveredPaths).toEqual([
      '.claude/rules/api.md',
      '.claude/skills/review/SKILL.md',
      '.cursor/rules/frontend.mdc',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.github/instructions/tests.instructions.md',
      '.mcp.json',
      '.windsurfrules',
      'AGENTS.md',
      'CLAUDE.local.md',
      'CLAUDE.md',
      'GEMINI.md',
      'packages/billing/AGENTS.md',
    ]);

    const byPath = new Map(result.harnessFiles.map((f) => [f.path, f]));

    // Check Agent Profiles
    expect(byPath.get('CLAUDE.md')?.agentProfiles).toEqual(['claude-code']);
    expect(byPath.get('.claude/rules/api.md')?.agentProfiles).toEqual(['claude-code']);
    expect(byPath.get('.cursor/rules/frontend.mdc')?.agentProfiles).toEqual(['cursor']);
    expect(byPath.get('.cursorrules')?.agentProfiles).toEqual(['cursor']);
    expect(byPath.get('AGENTS.md')?.agentProfiles).toContain('codex');
    expect(byPath.get('.github/copilot-instructions.md')?.agentProfiles).toEqual(['copilot']);
    expect(byPath.get('.github/instructions/tests.instructions.md')?.agentProfiles).toEqual(['copilot']);

    // Check Effective Scopes
    expect(byPath.get('CLAUDE.md')?.effectiveGlobs).toEqual(['**/*']);
    expect(byPath.get('CLAUDE.md')?.isAlwaysLoadedAtRoot).toBe(true);

    expect(byPath.get('.claude/rules/api.md')?.effectiveGlobs).toEqual(['packages/api/**/*.ts']);
    expect(byPath.get('.claude/rules/api.md')?.isAlwaysLoadedAtRoot).toBe(false);

    expect(byPath.get('.cursor/rules/frontend.mdc')?.effectiveGlobs).toEqual(['packages/web/**/*.tsx']);
    expect(byPath.get('.cursor/rules/frontend.mdc')?.isAlwaysLoadedAtRoot).toBe(false);

    expect(byPath.get('packages/billing/AGENTS.md')?.effectiveGlobs).toEqual(['packages/billing/**']);
    expect(byPath.get('packages/billing/AGENTS.md')?.isAlwaysLoadedAtRoot).toBe(false);

    expect(byPath.get('.github/instructions/tests.instructions.md')?.effectiveGlobs).toEqual(['**/*.test.ts']);
    expect(byPath.get('.github/instructions/tests.instructions.md')?.isAlwaysLoadedAtRoot).toBe(false);
  });
});

describe('Slice 2: Markdown AST Decomposition into Rule Sections, Context Notes, and Atomic Directives', () => {
  it('groups content by heading hierarchy into Rule Sections, classifies Context Notes vs Directives, and decomposes compound imperative clauses with exact 1-indexed spans', async () => {
    const claudeMd = [
      '# Architecture & Tooling',
      '',
      'This repository uses a modular monorepo layout for backend services.',
      '',
      '## Package Management',
      '- Use pnpm instead of npm for all workspace installs.',
      '- Prefer running `pnpm test` before committing.',
      '',
      '## Database Testing',
      '- Never mock the database; always use Testcontainers for integration tests in `packages/api/src/db.ts`.',
      '- Avoid default exports in `packages/api/src/router.ts`.',
      '',
      'See @docs/testing-guide.md for details.',
    ].join('\n');

    const cwd = createTempWorkspace({
      'CLAUDE.md': claudeMd,
      'docs/testing-guide.md': '# Guide\n- Always validate schemas.\n',
      'packages/api/src/db.ts': 'export const db = {};\n',
      'packages/api/src/router.ts': 'export const router = {};\n',
    });

    const result = await analyzeWorkspace({ cwd });
    const file = result.harnessFiles.find((f) => f.path === 'CLAUDE.md')!;
    expect(file).toBeDefined();

    // Verify Rule Sections grouped by headings
    expect(file.sections.map((s) => ({ heading: s.heading, level: s.headingLevel, lineStart: s.lineStart }))).toEqual([
      { heading: 'Architecture & Tooling', level: 1, lineStart: 1 },
      { heading: 'Package Management', level: 2, lineStart: 5 },
      { heading: 'Database Testing', level: 2, lineStart: 9 },
    ]);

    // Section 1 has a descriptive Context Note, 0 Directives
    expect(file.sections[0].directives).toHaveLength(0);
    expect(file.sections[0].contextNotes.length).toBeGreaterThanOrEqual(1);
    expect(file.sections[0].contextNotes[0].rawText).toContain('modular monorepo layout');
    expect(file.sections[0].contextNotes[0].lineStart).toBe(3);

    // Section 2 ("Package Management"):
    // "- Use pnpm instead of npm for all workspace installs." -> decomposes into MUST (pnpm) and MUST_NOT (npm) sharing line 6
    // "- Prefer running `pnpm test` before committing." -> SHOULD with referencedCommands ['pnpm test']
    const pkgDirectives = file.sections[1].directives;
    expect(pkgDirectives).toHaveLength(3);
    expect(pkgDirectives[0].modality).toBe('MUST');
    expect(pkgDirectives[0].rawText.toLowerCase()).toContain('pnpm');
    expect(pkgDirectives[0].lineStart).toBe(6);
    expect(pkgDirectives[0].columnStart).toBeGreaterThanOrEqual(1);

    expect(pkgDirectives[1].modality).toBe('MUST_NOT');
    expect(pkgDirectives[1].rawText.toLowerCase()).toContain('npm');
    expect(pkgDirectives[1].lineStart).toBe(6);

    expect(pkgDirectives[2].modality).toBe('SHOULD');
    expect(pkgDirectives[2].referencedCommands).toContain('pnpm test');
    expect(pkgDirectives[2].lineStart).toBe(7);

    // Section 3 ("Database Testing"):
    // "- Never mock the database; always use Testcontainers..." -> MUST_NOT and MUST on line 10
    // "- Avoid default exports in `packages/api/src/router.ts`." -> SHOULD_NOT on line 11
    const dbDirectives = file.sections[2].directives;
    expect(dbDirectives).toHaveLength(3);
    expect(dbDirectives[0].modality).toBe('MUST_NOT');
    expect(dbDirectives[0].lineStart).toBe(10);
    expect(dbDirectives[1].modality).toBe('MUST');
    expect(dbDirectives[1].lineStart).toBe(10);
    expect(dbDirectives[1].referencedPaths).toContain('packages/api/src/db.ts');

    expect(dbDirectives[2].modality).toBe('SHOULD_NOT');
    expect(dbDirectives[2].lineStart).toBe(11);
    expect(dbDirectives[2].referencedPaths).toContain('packages/api/src/router.ts');

    // Imports extracted
    expect(file.imports).toHaveLength(1);
    expect(file.imports[0].rawImport).toBe('@docs/testing-guide.md');
    expect(file.imports[0].targetPath).toBe('docs/testing-guide.md');
    expect(file.imports[0].lineStart).toBe(13);
  });
});

describe('Slice 3: CTX006 Broken @import File Targets and Circular Include Chains', () => {
  it('emits CTX006 error on missing @import targets and circular @import chains while ignoring valid imports and scoped npm packages', async () => {
    const cwd = createTempWorkspace({
      'package.json': JSON.stringify({
        name: 'my-workspace',
        dependencies: {
          '@tanstack/react-query': '^5.0.0',
        },
      }),
      'CLAUDE.md': [
        '# Root Rules',
        'Load @docs/existing.md for API conventions.',
        'Load @docs/missing-guide.md for auth conventions.',
        'We use @tanstack/react-query for data fetching.',
        'Include @.claude/rules/cycle-a.md here.',
      ].join('\n'),
      'docs/existing.md': '# API Conventions\n- Always validate input.\n',
      '.claude/rules/cycle-a.md': '# Cycle A\nSee @.claude/rules/cycle-b.md\n',
      '.claude/rules/cycle-b.md': '# Cycle B\nSee @.claude/rules/cycle-a.md\n',
    });

    const result = await analyzeWorkspace({ cwd });
    const ctx006 = result.diagnostics.filter((d) => d.code === 'CTX006');

    // Should flag @docs/missing-guide.md on line 3 of CLAUDE.md
    const missingDiag = ctx006.find(
      (d) => d.primaryLocation.file === 'CLAUDE.md' && d.primaryLocation.lineStart === 3,
    );
    expect(missingDiag).toBeDefined();
    expect(missingDiag?.severity).toBe('error');
    expect(missingDiag?.message).toContain('@docs/missing-guide.md');

    // Should NOT flag @docs/existing.md or @tanstack/react-query
    const falsePositive = ctx006.find(
      (d) =>
        d.message.includes('existing.md') ||
        d.message.includes('@tanstack/react-query'),
    );
    expect(falsePositive).toBeUndefined();

    // Should flag circular include chain between cycle-a.md and cycle-b.md
    const cycleDiag = ctx006.find((d) => d.message.toLowerCase().includes('circular'));
    expect(cycleDiag).toBeDefined();
    expect(cycleDiag?.severity).toBe('error');
    expect(cycleDiag?.message).toContain('cycle-a.md');
    expect(cycleDiag?.message).toContain('cycle-b.md');
  });
});

describe('Slice 4: Inline HTML Comment Pragmas and Repository Config (deontic.json / package.json#deontic)', () => {
  it('respects deontic-ignore pragmas, records deontic-override globs, and loads deontic.json / package.json#deontic rules & thresholds', async () => {
    const cwd1 = createTempWorkspace({
      'deontic.json': JSON.stringify({
        ignore: ['vendor/**'],
        maxDirectives: 120,
        maxMcpTools: 25,
        rules: {
          CTX006: 'warn',
        },
      }),
      'CLAUDE.md': [
        '# Root',
        '<!-- deontic-ignore CTX006 -->',
        'See @docs/suppressed-missing.md for details.',
        'See @docs/warned-missing.md for more.',
        '<!-- deontic-override: packages/legacy/** -->',
        '- Always use CommonJS in legacy modules.',
      ].join('\n'),
      'vendor/CLAUDE.md': '# Vendor\nSee @vendor/nonexistent.md\n',
    });

    const res1 = await analyzeWorkspace({ cwd: cwd1 });
    expect(res1.config.maxDirectives).toBe(120);
    expect(res1.config.maxMcpTools).toBe(25);
    // vendor/CLAUDE.md was ignored via deontic.json ignore
    expect(res1.harnessFiles.map((f) => f.path)).toEqual(['CLAUDE.md']);

    // @docs/suppressed-missing.md was suppressed by deontic-ignore CTX006
    // @docs/warned-missing.md was downgraded to warning by rules.CTX006 = "warn"
    expect(res1.diagnostics).toHaveLength(1);
    expect(res1.diagnostics[0].code).toBe('CTX006');
    expect(res1.diagnostics[0].severity).toBe('warning');
    expect(res1.diagnostics[0].message).toContain('@docs/warned-missing.md');

    // Check deontic-override recorded on directive
    const claudeFile = res1.harnessFiles[0];
    expect(claudeFile.directives[0].overrideGlobs).toContain('packages/legacy/**');

    // Also test package.json#deontic with rules.CTX006 = "off"
    const cwd2 = createTempWorkspace({
      'package.json': JSON.stringify({
        name: 'pkg-config-test',
        deontic: {
          maxDirectives: 90,
          rules: {
            CTX006: 'off',
          },
        },
      }),
      'CLAUDE.md': '# Root\nSee @docs/missing.md\n',
    });

    const res2 = await analyzeWorkspace({ cwd: cwd2 });
    expect(res2.config.maxDirectives).toBe(90);
    expect(res2.diagnostics).toHaveLength(0);
  });
});

describe('Slice 5: deontic check CLI (--format pretty | json, --agent, --strict, exit codes)', () => {
  it('renders Cargo-style pretty diagnostics and machine-readable JSON, filters by --agent, and exits 1 on errors or warnings with --strict', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': [
        '# Claude Rules',
        'See @docs/missing-claude.md for details.',
      ].join('\n'),
      '.cursor/rules/ui.mdc': [
        '---',
        'globs: ["src/**/*.tsx"]',
        '---',
        '# UI Rules',
        '- Prefer named exports.',
      ].join('\n'),
    });

    // 1. Default `deontic` (or `deontic check`) in pretty format exits 1 on CTX006 error
    const prettyRes = await runCli([], { cwd });
    expect(prettyRes.exitCode).toBe(1);
    expect(prettyRes.stdout).toContain('error[CTX006]:');
    expect(prettyRes.stdout).toContain('--> CLAUDE.md:2:');
    expect(prettyRes.stdout).toContain('@docs/missing-claude.md');

    // 2. `--agent cursor` filters out CLAUDE.md's CTX006 error and exits 0
    const cursorRes = await runCli(['check', '--agent', 'cursor'], { cwd });
    expect(cursorRes.exitCode).toBe(0);

    // 3. `--format json` returns structured JSON
    const jsonRes = await runCli(['check', '--format', 'json'], { cwd });
    expect(jsonRes.exitCode).toBe(1);
    const parsedJson = JSON.parse(jsonRes.stdout);
    expect(parsedJson.diagnostics).toHaveLength(1);
    expect(parsedJson.diagnostics[0].code).toBe('CTX006');
    expect(parsedJson.diagnostics[0].primaryLocation.file).toBe('CLAUDE.md');

    // 4. Downgrade CTX006 to warning via deontic.json: default check exits 0, `check --strict` exits 1
    fs.writeFileSync(
      path.join(cwd, 'deontic.json'),
      JSON.stringify({ rules: { CTX006: 'warn' } }),
      'utf8',
    );

    const warnRes = await runCli(['check'], { cwd });
    expect(warnRes.exitCode).toBe(0);
    expect(warnRes.stdout).toContain('warning[CTX006]:');

    const strictRes = await runCli(['check', '--strict'], { cwd });
    expect(strictRes.exitCode).toBe(1);
    expect(strictRes.stdout).toContain('warning[CTX006]:');
  });
});

describe('Slice 6: Checkout Boundary Detection & Git Worktree Isolation (ADR-0005)', () => {
  it('excludes child directories containing .git metadata (directory or gitlink file) as Checkout Boundaries without blindly ignoring tmp/, and degrades gracefully outside Git repos', async () => {
    const cwd = createTempWorkspace({
      'CLAUDE.md': '# Main Checkout\n- Always use pnpm.\n',
      'src/index.ts': 'export const main = true;\n',
      // Legitimate non-checkout files inside tmp/ -> MUST be discovered
      'tmp/fixtures/AGENTS.md': '# Fixture Agents\n- Always use pnpm.\n',
      'tmp/fixtures/sample.ts': 'export const sample = 1;\n',
      // Nested standalone clone in tmp/ with a .git/HEAD directory entry -> Checkout Boundary
      'tmp/standalone-clone/.git/HEAD': 'ref: refs/heads/main\n',
      'tmp/standalone-clone/CLAUDE.md': '# Clone Claude\n- Never use pnpm.\n',
      'tmp/standalone-clone/src/app.ts': 'export const clone = true;\n',
      // Nested submodule / worktree with a .git gitlink file -> Checkout Boundary
      'vendor/sub-checkout/.git': 'gitdir: ../../.git/modules/sub-checkout\n',
      'vendor/sub-checkout/AGENTS.md': '# Submodule Agents\n- Never use pnpm.\n',
      'vendor/sub-checkout/index.ts': 'export const sub = true;\n',
    });

    const result = await analyzeWorkspace({ cwd });

    expect(result.harnessFiles.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      'tmp/fixtures/AGENTS.md',
    ]);
    expect(result.repoFiles).toEqual([
      'CLAUDE.md',
      'src/index.ts',
      'tmp/fixtures/AGENTS.md',
      'tmp/fixtures/sample.ts',
    ]);
    expect(result.excludedCheckouts).toEqual([
      'tmp/standalone-clone',
      'vendor/sub-checkout',
    ]);
    // Because the conflicting clone and submodule were excluded as Checkout Boundaries, zero CTX001 contradictions occur
    expect(result.diagnostics.filter((d) => d.code === 'CTX001')).toHaveLength(0);
  });

  it('detects registered Git worktrees via git worktree list (even inside .worktrees/ or gitignored dirs) and audits a selected worktree in isolation when targeted as cwd', async () => {
    const cwd = createTempWorkspace({
      '.gitignore': '.worktrees/\n',
      'CLAUDE.md': '# Main Repo\n- Always use pnpm.\n',
      'src/index.ts': 'export const ok = true;\n',
    });

    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });

    const wtHidden = path.join(cwd, '.worktrees', 'feat-alpha');
    const wtTmp = path.join(cwd, 'tmp', 'wt-beta');
    execFileSync('git', ['worktree', 'add', '-b', 'feat-alpha', wtHidden], { cwd, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-b', 'wt-beta', wtTmp], { cwd, stdio: 'ignore' });

    // Modify the Harness Files inside the linked worktrees so they would conflict if scanned together
    fs.writeFileSync(path.join(wtHidden, 'CLAUDE.md'), '# Alpha Worktree\n- Never use pnpm.\n', 'utf8');
    fs.writeFileSync(path.join(wtTmp, 'CLAUDE.md'), '# Beta Worktree\n- Never use pnpm.\n', 'utf8');

    // 1. Auditing main checkout excludes both registered worktrees and records both in excludedCheckouts
    const mainRes = await analyzeWorkspace({ cwd });
    expect(mainRes.harnessFiles.map((f) => f.path)).toEqual(['CLAUDE.md']);
    expect(mainRes.excludedCheckouts).toEqual([
      '.worktrees/feat-alpha',
      'tmp/wt-beta',
    ]);
    expect(mainRes.diagnostics.filter((d) => d.code === 'CTX001')).toHaveLength(0);

    // 2. Auditing the linked worktree inside .worktrees/feat-alpha directly audits ONLY that worktree
    // and still excludes any deeper child Checkout Boundary nested inside it
    fs.mkdirSync(path.join(wtHidden, 'nested-clone', '.git'), { recursive: true });
    fs.writeFileSync(path.join(wtHidden, 'nested-clone', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.writeFileSync(path.join(wtHidden, 'nested-clone', 'CLAUDE.md'), '# Deeper Clone\n- Always use pnpm.\n', 'utf8');

    const alphaRes = await analyzeWorkspace({ cwd: wtHidden });
    expect(alphaRes.harnessFiles.map((f) => f.path)).toEqual(['CLAUDE.md']);
    expect(alphaRes.harnessFiles[0].rawContent).toContain('# Alpha Worktree');
    expect(alphaRes.excludedCheckouts).toEqual(['nested-clone']);
  });
});





