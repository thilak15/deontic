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
