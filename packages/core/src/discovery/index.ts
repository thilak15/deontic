import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { HarnessFile, ResolvedDeonticConfig } from '../types.js';
import { classifyHarnessFile, toPosixPath } from '../scope/index.js';
import { parseHarnessFile } from '../parser/index.js';

export interface DiscoveredWorkspaceFiles {
  harnessFiles: HarnessFile[];
  repoFiles: string[];
  gitignorePatterns: string[];
  excludedCheckouts: string[];
}

const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees']);

const ALLOWED_HIDDEN_DIRS = new Set(['.claude', '.cursor', '.github', '.vscode']);

const ALLOWED_HIDDEN_FILES = new Set([
  '.mcp.json',
  '.cursorrules',
  '.windsurfrules',
  '.gitignore',
]);

function resolveRealPath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function detectNestedGitWorktrees(cwd: string): string[] {
  const realCwd = resolveRealPath(cwd);

  let output: string;
  try {
    output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: realCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const nested: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.startsWith('worktree ')) continue;
    const rawWtPath = rawLine.slice('worktree '.length).trim();
    if (!rawWtPath) continue;

    const realWtPath = resolveRealPath(rawWtPath);
    if (realWtPath === realCwd) continue;
    if (realWtPath.startsWith(realCwd + path.sep)) {
      const rel = toPosixPath(path.relative(realCwd, realWtPath));
      if (rel && !rel.startsWith('..')) {
        nested.push(rel);
      }
    }
  }
  return nested;
}

export function parseGitignoreToGlobs(gitignoreContent: string): string[] {
  const globs: string[] = [];
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Do not let .gitignore accidentally ignore hidden harness dirs unless explicitly configured in deontic.json
    if (
      line === '.claude' ||
      line === '.claude/' ||
      line === '.cursor' ||
      line === '.cursor/' ||
      line === '.github' ||
      line === '.github/' ||
      line === '.vscode' ||
      line === '.vscode/' ||
      line === '.mcp.json' ||
      line === 'CLAUDE.local.md'
    ) {
      continue;
    }

    const cleaned = line.replace(/^\//, '');
    if (cleaned.endsWith('/')) {
      const dir = cleaned.slice(0, -1);
      globs.push(dir, `${dir}/**`, `**/${dir}`, `**/${dir}/**`);
    } else if (!cleaned.includes('/')) {
      globs.push(cleaned, `**/${cleaned}`, `${cleaned}/**`, `**/${cleaned}/**`);
    } else {
      globs.push(cleaned, `${cleaned}/**`);
    }
  }
  return globs;
}

export function discoverWorkspaceFiles(cwd: string, config: ResolvedDeonticConfig): DiscoveredWorkspaceFiles {
  const gitignorePath = path.join(cwd, '.gitignore');
  const gitignorePatterns = fs.existsSync(gitignorePath)
    ? parseGitignoreToGlobs(fs.readFileSync(gitignorePath, 'utf8'))
    : [];

  const configIgnoreGlobs: string[] = [];
  for (const pattern of config.ignore) {
    const cleaned = toPosixPath(pattern);
    configIgnoreGlobs.push(cleaned);
    if (cleaned.endsWith('/')) {
      configIgnoreGlobs.push(`${cleaned}**`);
    } else if (!cleaned.endsWith('/**')) {
      configIgnoreGlobs.push(`${cleaned}/**`);
    }
  }

  const allIgnoreGlobs = [...gitignorePatterns, ...configIgnoreGlobs];
  const isIgnored =
    allIgnoreGlobs.length > 0
      ? picomatch(allIgnoreGlobs, { dot: true })
      : () => false;

  const isConfigIgnored =
    configIgnoreGlobs.length > 0
      ? picomatch(configIgnoreGlobs, { dot: true })
      : () => false;

  const harnessFiles: HarnessFile[] = [];
  const repoFiles: string[] = [];
  const excludedCheckoutsSet = new Set<string>(detectNestedGitWorktrees(cwd));

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = toPosixPath(path.relative(cwd, fullPath));

      if (entry.isDirectory()) {
        if (excludedCheckoutsSet.has(relPath)) continue;
        if (fs.existsSync(path.join(fullPath, '.git'))) {
          excludedCheckoutsSet.add(relPath);
          continue;
        }
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && !ALLOWED_HIDDEN_DIRS.has(entry.name)) {
          continue;
        }
        if (isIgnored(relPath) || isIgnored(`${relPath}/`)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.') && !ALLOWED_HIDDEN_FILES.has(entry.name)) {
          // Allow files inside .claude, .cursor, .github, .vscode even if starting with dot? Usually not needed unless hidden harness file
          const inAllowedHiddenDir = Array.from(ALLOWED_HIDDEN_DIRS).some(
            (d) => relPath.startsWith(`${d}/`) || relPath.includes(`/${d}/`),
          );
          if (!inAllowedHiddenDir) continue;
        }

        if (isConfigIgnored(relPath)) continue;

        const format = classifyHarnessFile(relPath);
        if (format) {
          // For CLAUDE.local.md, allow even if gitignored unless ignored by parent dir or deontic config
          const isLocalClaude = path.posix.basename(relPath) === 'CLAUDE.local.md';
          if (!isLocalClaude && isIgnored(relPath)) {
            continue;
          }
          const rawContent = fs.readFileSync(fullPath, 'utf8');
          harnessFiles.push(parseHarnessFile(relPath, fullPath, format, rawContent));
          repoFiles.push(relPath);
        } else {
          if (isIgnored(relPath)) continue;
          repoFiles.push(relPath);
        }
      }
    }
  }

  walk(cwd);

  harnessFiles.sort((a, b) => a.path.localeCompare(b.path));
  repoFiles.sort((a, b) => a.localeCompare(b));
  const excludedCheckouts = Array.from(excludedCheckoutsSet).sort((a, b) => a.localeCompare(b));

  return {
    harnessFiles,
    repoFiles,
    gitignorePatterns,
    excludedCheckouts,
  };
}
