import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  AgentProfileBudget,
  AgentProfileId,
  ContextNote,
  CostProfileResult,
  DeonticConfig,
  Diagnostic,
  DiagnosticLocation,
  HarnessFile,
  ProfileFileCost,
  WorkspaceContext,
} from '../types.js';
import { loadWorkspaceConfig } from '../config/index.js';
import { discoverWorkspaceFiles } from '../discovery/index.js';
import { estimateTokenCount } from '../parser/index.js';

const AGENT_PROFILES: AgentProfileId[] = ['claude-code', 'cursor', 'codex', 'copilot'];

let cachedEncoder: Tiktoken | null = null;

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    if (!cachedEncoder) {
      cachedEncoder = getEncoding('cl100k_base');
    }
    return cachedEncoder.encode(text).length;
  } catch {
    return estimateTokenCount(text);
  }
}

export function isInstructionHarnessFile(hf: HarnessFile): boolean {
  return hf.format !== 'mcp-config' && hf.format !== 'claude-settings';
}

export interface DetectedDirectoryTree {
  file: string;
  kind: 'ascii-tree' | 'path-catalog';
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  lineCount: number;
  tokenCount: number;
}

function startsWithFilePathBullet(rawText: string): boolean {
  const stripped = rawText
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
  const firstToken = stripped.replace(/^[`'"]+/, '').split(/[\s`:—–-]+/)[0] ?? '';
  if (!firstToken) return false;
  return (
    firstToken.includes('/') ||
    /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdc|yml|yaml|toml|py|go|rs|sql|prisma|css|scss|html)$/i.test(
      firstToken,
    )
  );
}

export function detectDerivableDirectoryTrees(hf: HarnessFile): DetectedDirectoryTree[] {
  const detected: DetectedDirectoryTree[] = [];

  for (const section of hf.sections) {
    // 1. ASCII / box-drawing trees
    for (const note of section.contextNotes) {
      if (note.isDerivableDirectoryTree && note.treeKind === 'ascii-tree') {
        const lineCount = note.lineEnd - note.lineStart + 1;
        detected.push({
          file: hf.path,
          kind: 'ascii-tree',
          lineStart: note.lineStart,
          lineEnd: note.lineEnd,
          columnStart: note.columnStart,
          columnEnd: note.columnEnd,
          lineCount,
          tokenCount: countTokens(note.rawText),
        });
      }
    }

    // 2. Contiguous path-catalog bullet runs (>= 10 items, >= 70% start with path, 0 directives in range)
    const candidateNotes: ContextNote[] = section.contextNotes.filter(
      (n) => n.treeKind !== 'ascii-tree' && /^[-*+]\s+|^\d+\.\s+/.test(n.rawText.trim()),
    );

    if (candidateNotes.length >= 10) {
      // Group contiguous bullet notes that aren't interrupted by an imperative directive
      let run: ContextNote[] = [];
      const flushRun = () => {
        if (run.length >= 10) {
          const pathStarterCount = run.filter(
            (n) => n.isDerivableDirectoryTree || startsWithFilePathBullet(n.rawText),
          ).length;
          if (pathStarterCount / run.length >= 0.7) {
            const first = run[0];
            const last = run[run.length - 1];
            const combinedRaw = run.map((n) => n.rawText).join('\n');
            detected.push({
              file: hf.path,
              kind: 'path-catalog',
              lineStart: first.lineStart,
              lineEnd: last.lineEnd,
              columnStart: first.columnStart,
              columnEnd: last.columnEnd,
              lineCount: last.lineEnd - first.lineStart + 1,
              tokenCount: countTokens(combinedRaw),
            });
          }
        }
        run = [];
      };

      for (const note of candidateNotes) {
        if (run.length === 0) {
          run.push(note);
        } else {
          const prev = run[run.length - 1];
          const hasDirectiveBetween = section.directives.some(
            (d) => d.lineStart > prev.lineEnd && d.lineStart <= note.lineStart,
          );
          if (!hasDirectiveBetween && note.lineStart <= prev.lineEnd + 2) {
            run.push(note);
          } else {
            flushRun();
            run.push(note);
          }
        }
      }
      flushRun();
    }
  }

  return detected;
}

function makeFileTopLocation(hf: HarnessFile, label?: string): DiagnosticLocation {
  const firstLine = hf.rawContent.split(/\r?\n/)[0] ?? '';
  return {
    file: hf.path,
    lineStart: 1,
    lineEnd: 1,
    columnStart: 1,
    columnEnd: Math.max(2, firstLine.length + 1),
    label,
  };
}

function formatByteCapLabel(maxFileBytes: number): string {
  if (maxFileBytes === 32768) {
    return '32 KiB (32768 bytes)';
  }
  return `${maxFileBytes} bytes`;
}

export function buildProfileBudgets(
  ctx: WorkspaceContext,
): Record<AgentProfileId, AgentProfileBudget> {
  const instructionFiles = ctx.harnessFiles.filter(isInstructionHarnessFile);

  const fileCostByPath = new Map<string, ProfileFileCost>();
  for (const hf of instructionFiles) {
    const tokenCount = countTokens(hf.rawContent);
    hf.tokenCount = tokenCount;
    const trees = detectDerivableDirectoryTrees(hf);
    const wastedTreeTokens = trees.reduce((sum, t) => sum + t.tokenCount, 0);

    fileCostByPath.set(hf.path, {
      path: hf.path,
      byteSize: hf.byteSize,
      tokenCount,
      directiveCount: hf.directives.length,
      contextNoteCount: hf.contextNotes.length,
      wastedTreeTokens,
      isAlwaysLoadedAtRoot: hf.isAlwaysLoadedAtRoot,
    });
  }

  const profiles = {} as Record<AgentProfileId, AgentProfileBudget>;

  for (const profileId of AGENT_PROFILES) {
    const matchingHfs = instructionFiles.filter((hf) => hf.agentProfiles.includes(profileId));
    const files: ProfileFileCost[] = matchingHfs.map((hf) => ({ ...fileCostByPath.get(hf.path)! }));

    const turn0Files = files.filter((f) => f.isAlwaysLoadedAtRoot);
    const turn0Tokens = turn0Files.reduce((sum, f) => sum + f.tokenCount, 0);
    const turn0Bytes = turn0Files.reduce((sum, f) => sum + f.byteSize, 0);
    const turn0Directives = matchingHfs.reduce(
      (sum, hf) => sum + hf.directives.filter((d) => d.isAlwaysLoadedAtRoot).length,
      0,
    );
    const totalTokens = files.reduce((sum, f) => sum + f.tokenCount, 0);
    const totalDirectives = files.reduce((sum, f) => sum + f.directiveCount, 0);
    const wastedTreeTokens = files.reduce((sum, f) => sum + f.wastedTreeTokens, 0);

    profiles[profileId] = {
      agentProfile: profileId,
      turn0Tokens,
      turn0Bytes,
      turn0Directives,
      totalTokens,
      totalDirectives,
      wastedTreeTokens,
      mcpTokens: 0,
      mcpToolCount: 0,
      files,
      mcpServers: [],
      mcpCollisions: [],
    };
  }

  return profiles;
}

export function runBloatCliffPass(ctx: WorkspaceContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const instructionFiles = ctx.harnessFiles.filter(isInstructionHarnessFile);
  const hfByPath = new Map(instructionFiles.map((hf) => [hf.path, hf]));
  const profiles = buildProfileBudgets(ctx);

  const maxFileBytes = ctx.config.maxFileBytes;
  const maxDirectives = ctx.config.maxDirectives;
  const reportedByteCapFiles = new Set<string>();

  for (const profileId of AGENT_PROFILES) {
    const budget = profiles[profileId];
    const profileHfs = instructionFiles.filter((hf) => hf.agentProfiles.includes(profileId));
    if (profileHfs.length === 0) continue;

    // 1. Check Turn-0 byte payload against maxFileBytes (default 32 KiB = 32768 bytes)
    if (budget.turn0Bytes > maxFileBytes) {
      const turn0Hfs = profileHfs
        .filter((hf) => hf.isAlwaysLoadedAtRoot)
        .sort((a, b) => b.byteSize - a.byteSize || a.path.localeCompare(b.path));
      const primaryHf = turn0Hfs[0] ?? profileHfs[0];
      reportedByteCapFiles.add(primaryHf.path);

      const secondaryLocations = turn0Hfs
        .slice(1)
        .map((hf) => makeFileTopLocation(hf, `${hf.byteSize} bytes loaded at Turn 0`));

      diagnostics.push({
        code: 'CTX002',
        severity: 'error',
        agentProfile: profileId,
        message: `Turn-0 Load for Agent Profile '${profileId}' is ${budget.turn0Bytes} bytes (${budget.turn0Tokens} tokens), exceeding the ${formatByteCapLabel(maxFileBytes)} silent-truncation cap.`,
        primaryLocation: makeFileTopLocation(
          primaryHf,
          `${primaryHf.byteSize} bytes (${budget.turn0Bytes} Turn-0 bytes total)`,
        ),
        secondaryLocations: secondaryLocations.length > 0 ? secondaryLocations : undefined,
        suggestion: `Split domain-specific sections out of '${primaryHf.path}' into path-scoped Harness Files via 'deontic split'.`,
        help: `Harness payloads over ${formatByteCapLabel(maxFileBytes)} risk silent context truncation before Turn 1.`,
      });
    }

    // 2. Check Turn-0 (or active single-scope) imperative Directive count against maxDirectives (default 150)
    const maxScopedFileDirectives = profileHfs
      .filter((hf) => !hf.isAlwaysLoadedAtRoot)
      .reduce((max, hf) => Math.max(max, hf.directives.length), 0);
    const activeDirectiveCount =
      budget.turn0Directives > maxDirectives
        ? budget.turn0Directives
        : budget.turn0Directives + maxScopedFileDirectives;

    if (activeDirectiveCount > maxDirectives) {
      const sortedByDirectives = [...profileHfs].sort(
        (a, b) => b.directives.length - a.directives.length || a.path.localeCompare(b.path),
      );
      const primaryHf = sortedByDirectives[0];
      const secondaryLocations = sortedByDirectives
        .slice(1)
        .filter((hf) => hf.directives.length > 0)
        .map((hf) => makeFileTopLocation(hf, `${hf.directives.length} imperative Directives`));

      diagnostics.push({
        code: 'CTX002',
        severity: 'warning',
        agentProfile: profileId,
        message: `Agent Profile '${profileId}' loads ${activeDirectiveCount} imperative Directives at once, exceeding the ${maxDirectives}-Directive adherence cliff.`,
        primaryLocation: makeFileTopLocation(
          primaryHf,
          `${primaryHf.directives.length} Directives in '${primaryHf.path}' (${activeDirectiveCount} active total)`,
        ),
        secondaryLocations: secondaryLocations.length > 0 ? secondaryLocations : undefined,
        suggestion: `Move domain-specific Rule Sections into path-scoped Harness Files so fewer than ${maxDirectives} Directives are active simultaneously.`,
        help: `Frontier coding agents reliably follow ~${maxDirectives} imperative Directives before adherence degrades.`,
      });
    }
  }

  // 3. Check any individual scoped Harness File that exceeds maxFileBytes on its own
  for (const hf of instructionFiles) {
    if (hf.byteSize > maxFileBytes && !reportedByteCapFiles.has(hf.path)) {
      const profileId = hf.agentProfiles[0] ?? 'claude-code';
      const fileTokens = hfByPath.get(hf.path)?.tokenCount ?? countTokens(hf.rawContent);
      diagnostics.push({
        code: 'CTX002',
        severity: 'error',
        agentProfile: profileId,
        message: `Harness File '${hf.path}' is ${hf.byteSize} bytes (${fileTokens} tokens), exceeding the ${formatByteCapLabel(maxFileBytes)} silent-truncation cap.`,
        primaryLocation: makeFileTopLocation(hf, `${hf.byteSize} bytes`),
        suggestion: `Split '${hf.path}' into smaller path-scoped Harness Files.`,
        help: `Harness Files over ${formatByteCapLabel(maxFileBytes)} risk silent context truncation.`,
      });
    }
  }

  // 4. Detect Derivable Directory Trees (ASCII trees >= 8 lines and non-imperative path-catalog lists >= 10 items)
  for (const hf of instructionFiles) {
    const trees = detectDerivableDirectoryTrees(hf);
    for (const tree of trees) {
      const kindLabel =
        tree.kind === 'ascii-tree'
          ? `ASCII directory tree (${tree.lineCount} lines)`
          : `non-imperative path-catalog list (${tree.lineCount} lines)`;

      diagnostics.push({
        code: 'CTX002',
        severity: 'warning',
        agentProfile: hf.agentProfiles[0],
        message: `Derivable Directory Tree in '${hf.path}' (${kindLabel}, ~${tree.tokenCount} tokens): duplicates repository structure the agent can discover directly from the filesystem.`,
        primaryLocation: {
          file: hf.path,
          lineStart: tree.lineStart,
          lineEnd: tree.lineEnd,
          columnStart: tree.columnStart,
          columnEnd: tree.columnEnd,
          label: `${kindLabel} (${tree.tokenCount} wasted tokens)`,
        },
        suggestion: `Remove the derivable directory tree in '${hf.path}:${tree.lineStart}-${tree.lineEnd}' and keep only non-obvious architectural constraints.`,
        help: `Coding agents can inspect directory structure on demand using file/glob tools without paying a permanent Turn-0 token tax.`,
      });
    }
  }

  return diagnostics;
}

export async function profileWorkspaceCost(options: {
  cwd: string;
  probe?: boolean;
  config?: DeonticConfig;
}): Promise<CostProfileResult> {
  const config = loadWorkspaceConfig(options.cwd, options.config);
  const discovered = discoverWorkspaceFiles(options.cwd, config);

  const ctx: WorkspaceContext = {
    cwd: options.cwd,
    config,
    harnessFiles: discovered.harnessFiles,
    repoFiles: discovered.repoFiles,
    gitignorePatterns: discovered.gitignorePatterns,
    options: {
      cwd: options.cwd,
      probe: options.probe,
      config: options.config,
    },
  };

  const profiles = buildProfileBudgets(ctx);
  const diagnostics = runBloatCliffPass(ctx);

  return {
    cwd: options.cwd,
    profiles,
    diagnostics,
  };
}
