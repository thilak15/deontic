import path from 'node:path';
import picomatch from 'picomatch';
import type { AgentProfileId, HarnessFormat, HarnessFrontmatter } from '../types.js';

export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

export function classifyHarnessFile(relPath: string): HarnessFormat | null {
  const posix = toPosixPath(relPath);
  const base = path.posix.basename(posix);

  if (
    posix === '.mcp.json' ||
    posix === '.cursor/mcp.json' ||
    posix === '.vscode/mcp.json' ||
    posix === 'mcp.json' ||
    posix === 'claude_desktop_config.json' ||
    posix.endsWith('/.mcp.json')
  ) {
    return 'mcp-config';
  }

  if (posix === '.claude/settings.json' || posix === '.claude/settings.local.json') {
    return 'claude-settings';
  }

  if (
    (posix.startsWith('.claude/rules/') || posix.includes('/.claude/rules/')) &&
    (posix.endsWith('.md') || posix.endsWith('.mdc'))
  ) {
    return 'claude-rule';
  }

  if (
    (posix.startsWith('.claude/skills/') || posix.includes('/.claude/skills/')) &&
    base === 'SKILL.md'
  ) {
    return 'claude-skill';
  }

  if (
    (posix.startsWith('.cursor/rules/') || posix.includes('/.cursor/rules/')) &&
    (posix.endsWith('.mdc') || posix.endsWith('.md'))
  ) {
    return 'cursor-mdc';
  }

  if (posix === '.github/copilot-instructions.md') {
    return 'copilot-instructions';
  }

  if (posix.startsWith('.github/instructions/') && posix.endsWith('.instructions.md')) {
    return 'copilot-scoped';
  }

  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') {
    return 'claude-md';
  }

  if (base === '.cursorrules') {
    return 'cursorrules';
  }

  if (base === 'AGENTS.md') {
    return 'agents-md';
  }

  if (base === 'GEMINI.md') {
    return 'gemini-md';
  }

  if (base === '.windsurfrules') {
    return 'windsurfrules';
  }

  return null;
}

export function resolveAgentProfiles(relPath: string, format: HarnessFormat): AgentProfileId[] {
  const posix = toPosixPath(relPath);
  switch (format) {
    case 'claude-md':
    case 'claude-rule':
    case 'claude-skill':
    case 'claude-settings':
      return ['claude-code'];
    case 'cursor-mdc':
    case 'cursorrules':
      return ['cursor'];
    case 'agents-md':
    case 'gemini-md':
    case 'windsurfrules':
      return ['codex'];
    case 'copilot-instructions':
    case 'copilot-scoped':
      return ['copilot'];
    case 'mcp-config':
      if (posix === '.cursor/mcp.json') return ['cursor'];
      if (posix === '.vscode/mcp.json') return ['copilot'];
      if (posix === '.mcp.json' || posix.endsWith('/.mcp.json')) return ['claude-code'];
      return ['claude-code', 'cursor', 'codex', 'copilot'];
  }
}

export function normalizeGlobList(input: unknown): string[] {
  if (!input) return [];
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(input)) {
    const out: string[] = [];
    for (const item of input) {
      if (typeof item === 'string') {
        for (const part of item.split(',')) {
          const trimmed = part.trim();
          if (trimmed) out.push(trimmed);
        }
      }
    }
    return out;
  }
  return [];
}

export function resolveEffectiveScope(
  relPath: string,
  format: HarnessFormat,
  frontmatter?: HarnessFrontmatter,
): { effectiveGlobs: string[]; isAlwaysLoadedAtRoot: boolean } {
  const posix = toPosixPath(relPath);
  const fmGlobs = [
    ...(frontmatter?.paths ?? []),
    ...(frontmatter?.globs ?? []),
    ...(frontmatter?.applyTo ?? []),
  ].filter(Boolean);

  if (fmGlobs.length > 0) {
    return {
      effectiveGlobs: fmGlobs,
      isAlwaysLoadedAtRoot: frontmatter?.alwaysApply === true,
    };
  }

  if (format === 'claude-skill') {
    return {
      effectiveGlobs: ['**/*'],
      isAlwaysLoadedAtRoot: frontmatter?.alwaysApply === true,
    };
  }

  if (format === 'cursor-mdc') {
    const always = frontmatter?.alwaysApply !== false;
    return {
      effectiveGlobs: ['**/*'],
      isAlwaysLoadedAtRoot: always,
    };
  }

  if (format === 'claude-rule') {
    // Check if nested under a package's .claude/rules/
    const idx = posix.indexOf('.claude/rules/');
    if (idx > 0) {
      const prefix = posix.slice(0, idx).replace(/\/$/, '');
      return {
        effectiveGlobs: [`${prefix}/**`],
        isAlwaysLoadedAtRoot: false,
      };
    }
    return {
      effectiveGlobs: ['**/*'],
      isAlwaysLoadedAtRoot: true,
    };
  }

  if (format === 'copilot-scoped') {
    return {
      effectiveGlobs: ['**/*'],
      isAlwaysLoadedAtRoot: frontmatter?.alwaysApply === true,
    };
  }

  if (format === 'copilot-instructions' || format === 'mcp-config' || format === 'claude-settings') {
    return {
      effectiveGlobs: ['**/*'],
      isAlwaysLoadedAtRoot: true,
    };
  }

  // Directory-inherited files: CLAUDE.md, CLAUDE.local.md, AGENTS.md, GEMINI.md, .cursorrules, .windsurfrules
  const dir = path.posix.dirname(posix);
  if (dir === '.' || dir === '') {
    return {
      effectiveGlobs: ['**/*'],
      isAlwaysLoadedAtRoot: true,
    };
  }

  return {
    effectiveGlobs: [`${dir}/**`],
    isAlwaysLoadedAtRoot: false,
  };
}

export function matchesGlobSet(candidatePath: string, globs: string[]): boolean {
  const posix = toPosixPath(candidatePath);
  const positiveGlobs = globs.filter((g) => !g.startsWith('!'));
  const negativeGlobs = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));

  const matchesPositive =
    positiveGlobs.length === 0 ||
    positiveGlobs.some((g) => {
      if (g === '**/*' || g === '**' || g === '*') return true;
      return picomatch.isMatch(posix, g, { dot: true });
    });

  if (!matchesPositive) return false;

  const matchesNegative = negativeGlobs.some((g) => picomatch.isMatch(posix, g, { dot: true }));
  return !matchesNegative;
}

const HARNESS_META_FILE_REGEX =
  /(?:^|\/)(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|\.mcp\.json|mcp\.json|claude_desktop_config\.json|deontic\.json|package\.json|pnpm-lock\.yaml|tsconfig\.json|\.gitignore)$|^\.(?:claude|cursor|github|vscode)\//i;

function extractStaticPrefix(glob: string): string {
  const clean = toPosixPath(glob).replace(/^!+/, '').replace(/^\.\//, '');
  const parts = clean.split('/');
  const prefixParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('[') || part.includes('{')) {
      break;
    }
    prefixParts.push(part);
  }
  return prefixParts.join('/');
}

function extractCandidateSuffixes(glob: string): string[] {
  const clean = toPosixPath(glob).replace(/^!+/, '').replace(/^\.\//, '');
  const last = clean.split('/').pop() ?? '';
  const suffixes = new Set<string>();

  // Expand simple brace patterns like *.{ts,tsx}
  const braceMatch = /^(.*)\{([^}]+)\}(.*)$/.exec(last);
  const expandedLast = braceMatch
    ? braceMatch[2].split(',').map((opt) => `${braceMatch[1]}${opt.trim()}${braceMatch[3]}`)
    : [last];

  for (const pat of expandedLast) {
    if (!pat || pat === '**' || pat === '*') {
      suffixes.add('index.ts');
      suffixes.add('index.tsx');
      suffixes.add('index.test.ts');
      suffixes.add('sample.spec.ts');
    } else if (pat.startsWith('*.')) {
      const ext = pat.slice(1); // e.g. .ts, .test.ts, .spec.ts
      suffixes.add(`index${ext}`);
      suffixes.add(`sample${ext}`);
    } else if (pat.includes('*')) {
      const replaced = pat.replace(/\*\*?/g, 'sample');
      suffixes.add(replaced);
    } else {
      suffixes.add(pat);
    }
  }

  return Array.from(suffixes);
}

/**
 * Two-Tier Witness-Based Glob Intersection (ADR-0003).
 * Tier 1: Tests real tracked repository files and returns the shortest matching path.
 * Tier 2: Synthesizes candidate paths from static prefixes and suffixes of both glob sets.
 */
export function findWitnessIntersection(
  globsA: string[],
  globsB: string[],
  repoFiles: string[],
): string | null {
  // Tier 1: Real repository files (prefer non-harness source files first, then shortest path)
  const sourceFiles = repoFiles.filter((f) => !HARNESS_META_FILE_REGEX.test(f));
  const sortedSourceFiles = [...sourceFiles].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  for (const file of sortedSourceFiles) {
    if (matchesGlobSet(file, globsA) && matchesGlobSet(file, globsB)) {
      return toPosixPath(file);
    }
  }

  const allSortedFiles = [...repoFiles].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  for (const file of allSortedFiles) {
    if (matchesGlobSet(file, globsA) && matchesGlobSet(file, globsB)) {
      return toPosixPath(file);
    }
  }

  // Tier 2: Synthetic candidate witness paths from static stems and suffixes
  const posA = globsA.filter((g) => !g.startsWith('!'));
  const posB = globsB.filter((g) => !g.startsWith('!'));

  const prefixes = new Set<string>(['', 'src', 'packages/app/src']);
  for (const g of [...posA, ...posB]) {
    const p = extractStaticPrefix(g);
    if (p) {
      prefixes.add(p);
      prefixes.add(`${p}/src`);
      prefixes.add(`${p}/nested`);
    }
  }

  // Also add combinations where one prefix nests inside or matches the other
  const suffixes = new Set<string>([
    'index.ts',
    'index.tsx',
    'index.test.ts',
    'index.spec.ts',
    'route.ts',
    'page.tsx',
    'schema.prisma',
  ]);
  for (const g of [...posA, ...posB]) {
    for (const s of extractCandidateSuffixes(g)) {
      suffixes.add(s);
    }
  }

  const candidates: string[] = [];
  for (const pre of prefixes) {
    for (const suf of suffixes) {
      const candidate = pre ? `${pre.replace(/\/+$/, '')}/${suf.replace(/^\/+/, '')}` : suf;
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const candidate of candidates) {
    if (matchesGlobSet(candidate, globsA) && matchesGlobSet(candidate, globsB)) {
      return candidate;
    }
  }

  return null;
}

export function isUniversalRootGlobSet(globs: string[]): boolean {
  const pos = globs.filter((g) => !g.startsWith('!'));
  const neg = globs.filter((g) => g.startsWith('!'));
  if (neg.length > 0) return false;
  return pos.length === 0 || pos.every((g) => g === '**/*' || g === '**' || g === '*');
}

