import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type {
  Diagnostic,
  DiagnosticLocation,
  HarnessFile,
  WorkspaceContext,
} from '../types.js';
import { toPosixPath } from '../scope/index.js';

const DEPRECATION_LINE_REGEX =
  /\b(?:deleted|removed|deprecated|legacy|formerly|obsolete|historical|do\s+not\s+(?:import|use)|never\s+(?:import|use)|must\s+not\s+(?:import|use))\b/i;

const TEMPLATE_TOKEN_REGEX =
  /[<>]|\{[A-Za-z0-9_.-]+\}|\$[A-Za-z_{]|\*|(?:^|\/)(?:foo|bar|baz|qux|example|sample|placeholder|todo|your-[a-z0-9_-]+|my-[a-z0-9_-]+)(?:\/|\.|$)/i;

const MIME_OR_CONCEPT_SLASH_REGEX =
  /^(?:application|text|image|audio|video|multipart|font|model)\/[a-z0-9.+-]+$|^(?:http\/[123](?:\.\d)?|tcp\/ip|udp\/ip|ci\/cd|i\/o|ui\/ux|read\/write|true\/false|yes\/no|and\/or|client\/server|parent\/child|key\/value|pub\/sub|input\/output|on\/off|dev\/prod|ac\/dc|n\/a|w\/o)$/i;

const GIT_REF_PREFIX_REGEX =
  /^(?:origin|upstream|refs\/heads|refs\/tags|refs\/remotes)\/[A-Za-z0-9_./-]+$|^HEAD(?:~\d+|\^\d*)$/i;

const DEFAULT_BUILD_OUTPUT_DIRS = [
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'node_modules',
  '.turbo',
  '.cache',
  'target',
  '.output',
  '.nuxt',
  '.svelte-kit',
];

const BUILTIN_PM_SUBCOMMANDS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'up',
  'init',
  'link',
  'unlink',
  'publish',
  'pack',
  'outdated',
  'audit',
  'why',
  'list',
  'ls',
  'exec',
  'dlx',
  'create',
  'env',
  'store',
  'config',
  'cache',
  'patch',
  'dedupe',
  'prune',
  'rebuild',
  'import',
  'fetch',
  'licenses',
  'login',
  'logout',
  'whoami',
  'version',
  'help',
  'run',
  'workspace',
  'workspaces',
  'approve-builds',
  'prisma',
  'playwright',
  'vitest',
  'jest',
  'tsc',
  'tsx',
  'eslint',
  'prettier',
  'tsup',
]);

interface WorkspaceManifestInfo {
  hasPackageJson: boolean;
  hasMakefile: boolean;
  packageDependencies: Set<string>;
  scripts: Set<string>;
  makeTargets: Set<string>;
  tsconfigOutDirs: string[];
}

function loadWorkspaceManifests(ctx: WorkspaceContext): WorkspaceManifestInfo {
  const packageDependencies = new Set<string>();
  const scripts = new Set<string>();
  const makeTargets = new Set<string>();
  const tsconfigOutDirs: string[] = [];
  let hasPackageJson = false;
  let hasMakefile = false;

  const pkgJsonCandidates = new Set<string>(['package.json']);
  for (const rf of ctx.repoFiles) {
    if (rf === 'package.json' || rf.endsWith('/package.json')) {
      pkgJsonCandidates.add(rf);
    }
    if (rf === 'tsconfig.json' || rf.endsWith('/tsconfig.json')) {
      const absTs = path.resolve(ctx.cwd, rf);
      try {
        const raw = fs.readFileSync(absTs, 'utf8');
        const outDirMatch = /"outDir"\s*:\s*"([^"]+)"/.exec(raw);
        if (outDirMatch) {
          const baseDir = path.posix.dirname(toPosixPath(rf));
          const joined = baseDir === '.' ? outDirMatch[1] : path.posix.join(baseDir, outDirMatch[1]);
          tsconfigOutDirs.push(toPosixPath(joined).replace(/^\.\//, '').replace(/\/+$/, ''));
        }
      } catch {
        // ignore
      }
    }
  }

  for (const relPkg of pkgJsonCandidates) {
    const absPkg = path.resolve(ctx.cwd, relPkg);
    if (!fs.existsSync(absPkg)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(absPkg, 'utf8')) as Record<string, unknown>;
      hasPackageJson = true;
      if (typeof parsed.name === 'string') {
        packageDependencies.add(parsed.name);
      }
      for (const depField of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const depObj = parsed[depField];
        if (depObj && typeof depObj === 'object') {
          for (const key of Object.keys(depObj as Record<string, unknown>)) {
            packageDependencies.add(key);
          }
        }
      }
      if (parsed.scripts && typeof parsed.scripts === 'object') {
        for (const scriptName of Object.keys(parsed.scripts as Record<string, unknown>)) {
          scripts.add(scriptName);
        }
      }
    } catch {
      // ignore invalid package.json
    }
  }

  for (const makeName of ['Makefile', 'makefile', 'GNUmakefile']) {
    const absMake = path.resolve(ctx.cwd, makeName);
    if (!fs.existsSync(absMake)) continue;
    try {
      const raw = fs.readFileSync(absMake, 'utf8');
      hasMakefile = true;
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
        if (m && !m[1].startsWith('.')) {
          makeTargets.add(m[1]);
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    hasPackageJson,
    hasMakefile,
    packageDependencies,
    scripts,
    makeTargets,
    tsconfigOutDirs,
  };
}

function hasUnbackedBracketParam(relPath: string, cwd: string): boolean {
  const bracketMatch = /\[[^\]]+\]/.exec(relPath);
  if (!bracketMatch) return false;

  // Check if any parent segment up to the bracket segment actually exists on disk as a literal [param] directory
  const parts = toPosixPath(relPath).split('/');
  let current = cwd;
  for (const part of parts) {
    const nextPath = path.join(current, part);
    if (part.includes('[')) {
      return !fs.existsSync(nextPath);
    }
    if (!fs.existsSync(nextPath)) {
      return true;
    }
    current = nextPath;
  }
  return false;
}

function isNpmPackageReference(candidate: string, manifests: WorkspaceManifestInfo): boolean {
  const clean = candidate.replace(/^@+/, (m) => (m.length > 1 ? '@' : m));
  if (clean.startsWith('@')) {
    const parts = clean.split('/');
    if (parts.length >= 2) {
      const pkgName = `${parts[0]}/${parts[1]}`;
      if (manifests.packageDependencies.has(pkgName)) {
        return true;
      }
    }
  } else {
    const firstSeg = clean.split('/')[0];
    if (manifests.packageDependencies.has(firstSeg) || manifests.packageDependencies.has(clean)) {
      return true;
    }
  }
  return false;
}

function isIgnoredBuildOutput(
  relPath: string,
  ctx: WorkspaceContext,
  manifests: WorkspaceManifestInfo,
): boolean {
  const posix = toPosixPath(relPath).replace(/^\.\//, '').replace(/\/+$/, '');
  const firstSeg = posix.split('/')[0];

  if (DEFAULT_BUILD_OUTPUT_DIRS.includes(firstSeg)) {
    return true;
  }

  for (const outDir of manifests.tsconfigOutDirs) {
    if (posix === outDir || posix.startsWith(`${outDir}/`)) {
      return true;
    }
  }

  for (const rawPattern of ctx.gitignorePatterns) {
    const pat = rawPattern.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat || pat.startsWith('!')) continue;
    if (
      posix === pat ||
      posix.startsWith(`${pat}/`) ||
      picomatch.isMatch(posix, pat, { dot: true }) ||
      picomatch.isMatch(posix, `${pat}/**`, { dot: true })
    ) {
      return true;
    }
  }

  return false;
}

function resolveMovedOrRenamedPath(
  missingPath: string,
  ctx: WorkspaceContext,
): { newPath: string; commitSha?: string } | null {
  const posixMissing = toPosixPath(missingPath).replace(/^\.\//, '').replace(/\/+$/, '');

  // Tier 1: Query git log --full-history -M --diff-filter=R
  try {
    const gitOut = execFileSync(
      'git',
      [
        'log',
        '--full-history',
        '-M',
        '--diff-filter=R',
        '--format=COMMIT:%h',
        '--name-status',
        '-n',
        '5',
        '--',
        posixMissing,
      ],
      {
        cwd: ctx.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      },
    );

    let currentSha: string | undefined;
    for (const rawLine of gitOut.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('COMMIT:')) {
        currentSha = line.slice('COMMIT:'.length).trim();
        continue;
      }
      if (/^R\d+\t/.test(line)) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const oldP = toPosixPath(parts[1].trim());
          const newP = toPosixPath(parts[2].trim());
          if (oldP === posixMissing && fs.existsSync(path.resolve(ctx.cwd, newP))) {
            return { newPath: newP, commitSha: currentSha };
          }
        }
      }
    }
  } catch {
    // Git not initialized or shallow history; fall through to Tier 2
  }

  // Tier 2: Unique repository parent/basename or basename fallback
  const parts = posixMissing.split('/');
  const baseName = parts[parts.length - 1];
  if (!baseName) return null;

  if (parts.length >= 2) {
    const lastTwo = `${parts[parts.length - 2]}/${baseName}`;
    const suffixMatches = ctx.repoFiles.filter(
      (rf) => rf === lastTwo || rf.endsWith(`/${lastTwo}`),
    );
    if (suffixMatches.length === 1) {
      return { newPath: toPosixPath(suffixMatches[0]) };
    }
  }

  const baseMatches = ctx.repoFiles.filter(
    (rf) => rf === baseName || rf.endsWith(`/${baseName}`),
  );
  if (baseMatches.length === 1) {
    return { newPath: toPosixPath(baseMatches[0]) };
  }

  return null;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function findClosestScriptMatch(missingScript: string, validScripts: Set<string>): string | null {
  const candidates = Array.from(validScripts);
  if (candidates.length === 0) return null;

  // 1. Check if stripping or adding a trailing segment (e.g. test:unit:watch -> test:unit) matches uniquely
  const prefixMatches = candidates.filter(
    (c) => missingScript.startsWith(`${c}:`) || c.startsWith(`${missingScript}:`),
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  // 2. Check edit distance
  let best: string | null = null;
  let bestDist = Infinity;
  let tie = false;

  for (const cand of candidates) {
    const dist = levenshteinDistance(missingScript, cand);
    const maxAllowed = Math.max(2, Math.floor(Math.max(missingScript.length, cand.length) * 0.4));
    if (dist <= maxAllowed) {
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
        tie = false;
      } else if (dist === bestDist) {
        tie = true;
      }
    }
  }

  return tie ? null : best;
}

function findLineAndColumnOfToken(
  hf: HarnessFile,
  token: string,
  startLineHint: number,
  endLineHint: number,
): DiagnosticLocation {
  const lines = hf.rawContent.split(/\r?\n/);
  const minLine = Math.max(1, startLineHint);
  const maxLine = Math.min(lines.length, Math.max(minLine, endLineHint));

  for (let ln = minLine; ln <= maxLine; ln++) {
    const lineText = lines[ln - 1] ?? '';
    const idx = lineText.indexOf(token);
    if (idx !== -1) {
      return {
        file: hf.path,
        lineStart: ln,
        lineEnd: ln,
        columnStart: idx + 1,
        columnEnd: idx + 1 + token.length,
        snippet: lineText,
      };
    }
  }

  return {
    file: hf.path,
    lineStart: minLine,
    lineEnd: minLine,
    columnStart: 1,
    columnEnd: (lines[minLine - 1]?.length ?? 1) + 1,
    snippet: lines[minLine - 1] ?? '',
  };
}

function parseCommandForScriptCheck(rawCommand: string): {
  kind: 'package-script' | 'make-target';
  scriptName: string;
} | null {
  const trimmed = rawCommand.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;

  const runner = tokens[0];
  if (runner === 'make') {
    const target = tokens.find((t, idx) => idx > 0 && !t.startsWith('-'));
    if (!target) return null;
    return { kind: 'make-target', scriptName: target };
  }

  if (runner === 'npm' || runner === 'pnpm' || runner === 'yarn' || runner === 'bun') {
    let idx = 1;
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok === '--filter' || tok === '-F' || tok === '--prefix' || tok === '-C') {
        idx += 2;
        continue;
      }
      if (tok.startsWith('-')) {
        idx += 1;
        continue;
      }
      break;
    }

    if (idx >= tokens.length) return null;
    const firstArg = tokens[idx];

    if (firstArg === 'run' || firstArg === 'run-script') {
      const scriptName = tokens[idx + 1];
      if (!scriptName || scriptName.startsWith('-')) return null;
      return { kind: 'package-script', scriptName };
    }

    if (BUILTIN_PM_SUBCOMMANDS.has(firstArg)) {
      return null;
    }

    return { kind: 'package-script', scriptName: firstArg };
  }

  return null;
}

export function runGroundTruthPass(ctx: WorkspaceContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const manifests = loadWorkspaceManifests(ctx);
  const hfDirOf = (hfPath: string) => {
    const d = path.posix.dirname(toPosixPath(hfPath));
    return d === '.' ? '' : d;
  };

  for (const hf of ctx.harnessFiles) {
    if (hf.format === 'mcp-config' || hf.format === 'claude-settings') {
      continue;
    }

    const lines = hf.rawContent.split(/\r?\n/);
    const checkedPathsInFile = new Set<string>();
    const checkedCommandsInFile = new Set<string>();

    const statements: Array<{
      lineStart: number;
      lineEnd: number;
      rawText: string;
      referencedPaths: string[];
      referencedCommands: string[];
      isProhibitedOrDeprecated: boolean;
    }> = [
      ...hf.directives.map((d) => ({
        lineStart: d.lineStart,
        lineEnd: d.lineEnd,
        rawText: d.rawText,
        referencedPaths: d.referencedPaths,
        referencedCommands: d.referencedCommands,
        isProhibitedOrDeprecated:
          d.modality === 'MUST_NOT' ||
          d.deprecatedContext === true ||
          DEPRECATION_LINE_REGEX.test(d.rawText),
      })),
      ...hf.contextNotes.map((n) => ({
        lineStart: n.lineStart,
        lineEnd: n.lineEnd,
        rawText: n.rawText,
        referencedPaths: n.referencedPaths,
        referencedCommands: n.referencedCommands,
        isProhibitedOrDeprecated: DEPRECATION_LINE_REGEX.test(n.rawText),
      })),
    ];

    for (const stmt of statements) {
      // 1. Verify referenced file & directory paths (CTX004)
      for (const rawRef of stmt.referencedPaths) {
        const cleanedRef = rawRef.trim().replace(/^[`'"]+|[`'",.:;!?)]+$/g, '');
        if (!cleanedRef) continue;

        const loc = findLineAndColumnOfToken(hf, cleanedRef, stmt.lineStart, stmt.lineEnd);
        const lineText = lines[loc.lineStart - 1] ?? stmt.rawText;

        // Guard 1: Negation / Deprecation Guard
        if (stmt.isProhibitedOrDeprecated || DEPRECATION_LINE_REGEX.test(lineText)) {
          continue;
        }

        // Guard 2: Template / Placeholder Guard
        if (TEMPLATE_TOKEN_REGEX.test(cleanedRef) || hasUnbackedBracketParam(cleanedRef, ctx.cwd)) {
          continue;
        }

        // Guard 3: Lexical Disambiguation Guard
        if (
          cleanedRef.startsWith('/') ||
          MIME_OR_CONCEPT_SLASH_REGEX.test(cleanedRef) ||
          GIT_REF_PREFIX_REGEX.test(cleanedRef) ||
          isNpmPackageReference(cleanedRef, manifests)
        ) {
          continue;
        }

        // Also skip slash-separated words with no file extension when the first segment is not an existing top-level directory or common source root
        const normRef = toPosixPath(cleanedRef).replace(/^\.\//, '').replace(/\/+$/, '');
        const segs = normRef.split('/');
        const lastSeg = segs[segs.length - 1] ?? '';
        const hasExt = /\.[A-Za-z0-9]+$/.test(lastSeg);
        const topSeg = segs[0] ?? '';
        const COMMON_REPO_ROOTS = new Set([
          'src',
          'packages',
          'apps',
          'lib',
          'test',
          'tests',
          'e2e',
          'prisma',
          'scripts',
          'docs',
          'config',
          'public',
          'server',
          'client',
          'cmd',
          'internal',
          'pkg',
        ]);
        if (
          !hasExt &&
          !rawRef.endsWith('/') &&
          !COMMON_REPO_ROOTS.has(topSeg) &&
          !fs.existsSync(path.resolve(ctx.cwd, topSeg))
        ) {
          continue;
        }

        // Guard 4: Build-Output & .gitignore Guard
        if (isIgnoredBuildOutput(normRef, ctx, manifests)) {
          continue;
        }

        const dedupKey = `${loc.lineStart}:${cleanedRef}`;
        if (checkedPathsInFile.has(dedupKey)) continue;
        checkedPathsInFile.add(dedupKey);

        // Check existence relative to workspace root AND relative to the Harness File's directory
        const absFromRoot = path.resolve(ctx.cwd, normRef);
        const hfDir = hfDirOf(hf.path);
        const absFromHfDir = hfDir ? path.resolve(ctx.cwd, hfDir, normRef) : absFromRoot;

        if (fs.existsSync(absFromRoot) || fs.existsSync(absFromHfDir)) {
          continue;
        }

        const renameResolution = resolveMovedOrRenamedPath(normRef, ctx);
        const helpText = renameResolution
          ? renameResolution.commitSha
            ? `File '${cleanedRef}' does not exist (renamed to '${renameResolution.newPath}' in commit ${renameResolution.commitSha}).`
            : `File '${cleanedRef}' does not exist (moved to '${renameResolution.newPath}').`
          : `File or directory '${cleanedRef}' does not exist in the repository.`;

        const fix: Diagnostic['fix'] | undefined = renameResolution
          ? {
              description: `Update dead reference '${cleanedRef}' to '${renameResolution.newPath}' in ${hf.path}`,
              edits: [
                {
                  file: hf.path,
                  lineStart: loc.lineStart,
                  lineEnd: loc.lineEnd,
                  oldText: cleanedRef,
                  newText: renameResolution.newPath,
                },
              ],
            }
          : undefined;

        diagnostics.push({
          code: 'CTX004',
          severity: 'error',
          message: `Dead Reference: '${cleanedRef}' does not exist in workspace`,
          primaryLocation: {
            ...loc,
            label: renameResolution
              ? `renamed/moved to '${renameResolution.newPath}'`
              : 'path does not exist',
          },
          suggestion: renameResolution
            ? `Replace '${cleanedRef}' with '${renameResolution.newPath}' (or run 'deontic check --fix').`
            : `Remove or update the stale path '${cleanedRef}'.`,
          help: helpText,
          fix,
        });
      }

      // 2. Verify referenced package.json / Makefile commands (CTX005)
      for (const rawCmd of stmt.referencedCommands) {
        if (stmt.isProhibitedOrDeprecated) continue;
        const parsedCmd = parseCommandForScriptCheck(rawCmd);
        if (!parsedCmd) continue;

        const loc = findLineAndColumnOfToken(hf, rawCmd, stmt.lineStart, stmt.lineEnd);
        const lineText = lines[loc.lineStart - 1] ?? stmt.rawText;
        if (DEPRECATION_LINE_REGEX.test(lineText)) continue;

        const dedupKey = `${loc.lineStart}:${rawCmd}`;
        if (checkedCommandsInFile.has(dedupKey)) continue;
        checkedCommandsInFile.add(dedupKey);

        if (parsedCmd.kind === 'package-script') {
          if (!manifests.hasPackageJson) continue;
          if (manifests.scripts.has(parsedCmd.scriptName)) continue;

          const closest = findClosestScriptMatch(parsedCmd.scriptName, manifests.scripts);
          const newCmd = closest ? rawCmd.replace(parsedCmd.scriptName, closest) : undefined;

          diagnostics.push({
            code: 'CTX005',
            severity: 'error',
            message: `Dead Script Reference: script '${parsedCmd.scriptName}' (in '${rawCmd}') does not exist in package.json`,
            primaryLocation: {
              ...loc,
              label: closest
                ? `missing script '${parsedCmd.scriptName}' (did you mean '${closest}'?)`
                : `missing script '${parsedCmd.scriptName}'`,
            },
            suggestion: closest
              ? `Replace '${parsedCmd.scriptName}' with '${closest}' (or run 'deontic check --fix').`
              : `Define '${parsedCmd.scriptName}' in package.json#scripts or remove the dead command.`,
            help: closest
              ? `Script '${parsedCmd.scriptName}' was not found in package.json. Closest match: '${closest}'.`
              : `Available scripts in package.json: ${Array.from(manifests.scripts).join(', ') || '(none)'}.`,
            fix:
              closest && newCmd
                ? {
                    description: `Replace dead script '${parsedCmd.scriptName}' with '${closest}' in ${hf.path}`,
                    edits: [
                      {
                        file: hf.path,
                        lineStart: loc.lineStart,
                        lineEnd: loc.lineEnd,
                        oldText: rawCmd,
                        newText: newCmd,
                      },
                    ],
                  }
                : undefined,
          });
        } else if (parsedCmd.kind === 'make-target') {
          if (!manifests.hasMakefile) continue;
          if (manifests.makeTargets.has(parsedCmd.scriptName)) continue;

          const closest = findClosestScriptMatch(parsedCmd.scriptName, manifests.makeTargets);
          const newCmd = closest ? rawCmd.replace(parsedCmd.scriptName, closest) : undefined;

          diagnostics.push({
            code: 'CTX005',
            severity: 'error',
            message: `Dead Script Reference: Makefile target '${parsedCmd.scriptName}' (in '${rawCmd}') does not exist in Makefile`,
            primaryLocation: {
              ...loc,
              label: closest
                ? `missing target '${parsedCmd.scriptName}' (did you mean '${closest}'?)`
                : `missing target '${parsedCmd.scriptName}'`,
            },
            suggestion: closest
              ? `Replace '${parsedCmd.scriptName}' with '${closest}' (or run 'deontic check --fix').`
              : `Define '${parsedCmd.scriptName}' in Makefile or remove the dead command.`,
            help: closest
              ? `Target '${parsedCmd.scriptName}' was not found in Makefile. Closest match: '${closest}'.`
              : `Available Makefile targets: ${Array.from(manifests.makeTargets).join(', ') || '(none)'}.`,
            fix:
              closest && newCmd
                ? {
                    description: `Replace dead Makefile target '${parsedCmd.scriptName}' with '${closest}' in ${hf.path}`,
                    edits: [
                      {
                        file: hf.path,
                        lineStart: loc.lineStart,
                        lineEnd: loc.lineEnd,
                        oldText: rawCmd,
                        newText: newCmd,
                      },
                    ],
                  }
                : undefined,
          });
        }
      }
    }
  }

  return diagnostics;
}
