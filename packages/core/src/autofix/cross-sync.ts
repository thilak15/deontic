import fs from 'node:fs';
import path from 'node:path';
import type {
  HarnessFile,
  SyncTargetFile,
  SyncWorkspaceOptions,
  SyncWorkspaceResult,
} from '../types.js';
import { loadWorkspaceConfig } from '../config/index.js';
import { discoverWorkspaceFiles } from '../discovery/index.js';
import { isUniversalRootGlobSet, toPosixPath } from '../scope/index.js';

interface CanonicalSyncUnit {
  id: string;
  description?: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
  sourceFile: string;
  emitScopedRuleFile: boolean;
}

export function stripYamlFrontmatter(rawContent: string): string {
  return rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

export function stripSyncedBlocks(rawContent: string): string {
  return rawContent
    .replace(/<!--\s*deontic:sync\b[\s\S]*?<!--\s*\/deontic:sync\s*-->/gi, '')
    .trim();
}

// Checks whether a glob set is a pure single-directory scope such as `packages/api/**`
// (with no file-extension filter or multi-pattern wildcards).
export function extractPureDirectoryScope(globs: string[]): string | null {
  const pos = globs.filter((g) => !g.startsWith('!'));
  const neg = globs.filter((g) => g.startsWith('!'));
  if (neg.length > 0 || pos.length !== 1) return null;

  const clean = toPosixPath(pos[0]).replace(/^\.\//, '');
  const match = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)\/\*\*(?:\/\*|\*)?$/.exec(clean);
  if (!match) return null;
  return match[1];
}

// Computes the longest common directory ancestor across a list of globs.
export function findLongestCommonDirectoryAncestor(globs: string[]): string {
  const pos = globs.filter((g) => !g.startsWith('!'));
  if (pos.length === 0) return '';

  const splitPrefixes: string[][] = [];
  for (const g of pos) {
    const clean = toPosixPath(g).replace(/^\.\//, '');
    const parts = clean.split('/');
    const staticDirParts: string[] = [];
    // Exclude the last segment unless it is followed by `**` because the last segment may be a filename
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (seg.includes('*') || seg.includes('?') || seg.includes('[') || seg.includes('{')) {
        break;
      }
      staticDirParts.push(seg);
    }
    splitPrefixes.push(staticDirParts);
  }

  if (splitPrefixes.length === 0 || splitPrefixes[0].length === 0) return '';

  const common: string[] = [];
  const first = splitPrefixes[0];
  for (let i = 0; i < first.length; i++) {
    const candidate = first[i];
    if (splitPrefixes.every((p) => p[i] === candidate)) {
      common.push(candidate);
    } else {
      break;
    }
  }

  return common.join('/');
}

export function resolveAgentsMdTargetPath(globs: string[]): string {
  if (isUniversalRootGlobSet(globs)) {
    return 'AGENTS.md';
  }
  const pureDir = extractPureDirectoryScope(globs);
  if (pureDir) {
    return `${pureDir}/AGENTS.md`;
  }
  const ancestor = findLongestCommonDirectoryAncestor(globs);
  return ancestor ? `${ancestor}/AGENTS.md` : 'AGENTS.md';
}

function buildCursorMdcContent(unit: CanonicalSyncUnit): string {
  const lines: string[] = ['---'];
  const desc = unit.description ?? `Synced rule (${unit.id})`;
  lines.push(`description: ${JSON.stringify(desc)}`);
  if (unit.alwaysApply && isUniversalRootGlobSet(unit.globs)) {
    lines.push('alwaysApply: true');
  } else {
    lines.push(`globs: ${unit.globs.join(', ')}`);
    lines.push('alwaysApply: false');
  }
  lines.push('---');
  lines.push('');
  lines.push(unit.body);
  return lines.join('\n').trimEnd() + '\n';
}

function buildClaudeRuleMdContent(unit: CanonicalSyncUnit): string {
  const lines: string[] = ['---'];
  if (unit.description) {
    lines.push(`description: ${JSON.stringify(unit.description)}`);
  }
  if (!isUniversalRootGlobSet(unit.globs)) {
    lines.push('paths:');
    for (const g of unit.globs) {
      lines.push(`  - ${JSON.stringify(g)}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(unit.body);
  return lines.join('\n').trimEnd() + '\n';
}

function formatSyncBlock(unit: CanonicalSyncUnit): string {
  const globsAttr = unit.globs.join(', ');
  return [
    `<!-- deontic:sync id="${unit.id}" globs="${globsAttr}" -->`,
    unit.body.trim(),
    `<!-- /deontic:sync -->`,
  ].join('\n');
}

function mergeSyncBlocksIntoMarkdown(existingContent: string, units: CanonicalSyncUnit[]): string {
  const normalizedExisting = existingContent.replace(/\r\n/g, '\n');

  // Remove all existing `<!-- deontic:sync ... -->...<!-- /deontic:sync -->` blocks
  // while preserving user-authored content outside those blocks.
  const blockRegex = /<!--\s*deontic:sync\s+id="([^"]+)"\s+globs="([^"]*)"\s*-->[\s\S]*?<!--\s*\/deontic:sync\s*-->\n?/gi;
  const preservedContent = normalizedExisting.replace(blockRegex, '').trim();

  const sortedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const renderedBlocks = sortedUnits.map((u) => formatSyncBlock(u)).join('\n\n');

  if (!preservedContent) {
    return renderedBlocks ? `${renderedBlocks}\n` : '';
  }
  if (!renderedBlocks) {
    return `${preservedContent}\n`;
  }
  return `${preservedContent}\n\n${renderedBlocks}\n`;
}

function collectCanonicalUnitsFromClaude(harnessFiles: HarnessFile[]): CanonicalSyncUnit[] {
  const units: CanonicalSyncUnit[] = [];

  // 1. Collect `.claude/rules/*.md`
  const claudeRules = harnessFiles
    .filter((f) => f.format === 'claude-rule')
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const hf of claudeRules) {
    const baseName = path.posix.basename(hf.path).replace(/\.(?:md|mdc)$/i, '');
    const body = stripSyncedBlocks(stripYamlFrontmatter(hf.rawContent));
    if (!body) continue;

    units.push({
      id: baseName,
      description: hf.frontmatter?.description ?? hf.sections[0]?.heading,
      globs: hf.effectiveGlobs,
      alwaysApply: hf.isAlwaysLoadedAtRoot && isUniversalRootGlobSet(hf.effectiveGlobs),
      body,
      sourceFile: hf.path,
      emitScopedRuleFile: true,
    });
  }

  // 2. Collect `CLAUDE.md` files
  const claudeMdFiles = harnessFiles
    .filter((f) => f.format === 'claude-md' && path.posix.basename(f.path) === 'CLAUDE.md')
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const hf of claudeMdFiles) {
    const body = stripSyncedBlocks(stripYamlFrontmatter(hf.rawContent));
    if (!body) continue;
    const dir = path.posix.dirname(hf.path);
    const id = dir === '.' || dir === '' ? 'claude-md' : `claude-md-${dir.replace(/\//g, '-')}`;

    units.push({
      id,
      description: `Synced from ${hf.path}`,
      globs: hf.effectiveGlobs,
      alwaysApply: hf.isAlwaysLoadedAtRoot && isUniversalRootGlobSet(hf.effectiveGlobs),
      body,
      sourceFile: hf.path,
      // Emit a `.cursor/rules/claude-md.mdc` if there are no dedicated `.claude/rules/*.md` files
      // or if this is root/subdir CLAUDE.md instructions that Cursor also needs
      emitScopedRuleFile: true,
    });
  }

  return units;
}

function collectCanonicalUnitsFromCursor(harnessFiles: HarnessFile[]): CanonicalSyncUnit[] {
  const units: CanonicalSyncUnit[] = [];

  // 1. Collect `.cursor/rules/*.mdc`
  const cursorRules = harnessFiles
    .filter((f) => f.format === 'cursor-mdc')
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const hf of cursorRules) {
    const baseName = path.posix.basename(hf.path).replace(/\.(?:mdc|md)$/i, '');
    const body = stripSyncedBlocks(stripYamlFrontmatter(hf.rawContent));
    if (!body) continue;

    units.push({
      id: baseName,
      description: hf.frontmatter?.description ?? hf.sections[0]?.heading,
      globs: hf.effectiveGlobs,
      alwaysApply: hf.isAlwaysLoadedAtRoot && isUniversalRootGlobSet(hf.effectiveGlobs),
      body,
      sourceFile: hf.path,
      emitScopedRuleFile: baseName !== 'claude-md',
    });
  }

  // 2. Collect `.cursorrules` if present
  const cursorRulesLegacy = harnessFiles
    .filter((f) => f.format === 'cursorrules')
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const hf of cursorRulesLegacy) {
    const body = stripSyncedBlocks(stripYamlFrontmatter(hf.rawContent));
    if (!body) continue;
    const dir = path.posix.dirname(hf.path);
    const id = dir === '.' || dir === '' ? 'cursorrules' : `cursorrules-${dir.replace(/\//g, '-')}`;

    units.push({
      id,
      description: `Synced from ${hf.path}`,
      globs: hf.effectiveGlobs,
      alwaysApply: hf.isAlwaysLoadedAtRoot && isUniversalRootGlobSet(hf.effectiveGlobs),
      body,
      sourceFile: hf.path,
      emitScopedRuleFile: true,
    });
  }

  return units;
}

export async function syncWorkspace(options: SyncWorkspaceOptions): Promise<SyncWorkspaceResult> {
  const from = options.from ?? 'claude';
  const config = loadWorkspaceConfig(options.cwd);
  const discovered = discoverWorkspaceFiles(options.cwd, config);

  const units =
    from === 'claude'
      ? collectCanonicalUnitsFromClaude(discovered.harnessFiles)
      : collectCanonicalUnitsFromCursor(discovered.harnessFiles);

  const plannedContents = new Map<string, string>();
  const agentsMdBuckets = new Map<string, CanonicalSyncUnit[]>();

  for (const unit of units) {
    if (from === 'claude' && unit.emitScopedRuleFile) {
      const targetCursorPath = `.cursor/rules/${unit.id}.mdc`;
      plannedContents.set(targetCursorPath, buildCursorMdcContent(unit));
    } else if (from === 'cursor') {
      if (unit.id === 'claude-md') {
        const claudeTarget = 'CLAUDE.md';
        const existingClaude = fs.existsSync(path.resolve(options.cwd, claudeTarget))
          ? fs.readFileSync(path.resolve(options.cwd, claudeTarget), 'utf8')
          : '';
        plannedContents.set(claudeTarget, mergeSyncBlocksIntoMarkdown(existingClaude, [unit]));
      } else if (unit.emitScopedRuleFile) {
        const targetClaudePath = `.claude/rules/${unit.id}.md`;
        plannedContents.set(targetClaudePath, buildClaudeRuleMdContent(unit));
      }
    }

    const agentsTarget = resolveAgentsMdTargetPath(unit.globs);
    const list = agentsMdBuckets.get(agentsTarget) ?? [];
    list.push(unit);
    agentsMdBuckets.set(agentsTarget, list);
  }

  for (const [agentsPath, bucketUnits] of agentsMdBuckets.entries()) {
    const absPath = path.resolve(options.cwd, agentsPath);
    const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    const merged = mergeSyncBlocksIntoMarkdown(existing, bucketUnits);
    plannedContents.set(agentsPath, merged);
  }

  const targets: SyncTargetFile[] = [];
  const sortedPaths = Array.from(plannedContents.keys()).sort((a, b) => a.localeCompare(b));

  for (const relPath of sortedPaths) {
    const desiredContent = plannedContents.get(relPath)!;
    const absPath = path.resolve(options.cwd, relPath);
    let currentContent: string | null = null;
    if (fs.existsSync(absPath)) {
      currentContent = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
    }

    const drifted = currentContent === null || currentContent !== desiredContent;
    if (options.write && drifted) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, desiredContent, 'utf8');
    }

    targets.push({
      path: relPath,
      content: desiredContent,
      drifted: options.write ? false : drifted,
    });
  }

  const anyDriftedBeforeWrite = targets.some((t) => {
    const absPath = path.resolve(options.cwd, t.path);
    if (!fs.existsSync(absPath)) return true;
    return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n') !== t.content;
  });

  return {
    cwd: options.cwd,
    from,
    written: Boolean(options.write),
    inSync: options.write ? true : !anyDriftedBeforeWrite,
    targets,
  };
}
