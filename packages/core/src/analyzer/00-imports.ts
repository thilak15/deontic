import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic, ImportRef, WorkspaceContext } from '../types.js';
import { toPosixPath } from '../scope/index.js';
import { extractImportsFromLines } from '../parser/index.js';

export function collectWorkspacePackageNames(cwd: string, repoFiles: string[]): Set<string> {
  const pkgNames = new Set<string>();
  const pkgJsonFiles = repoFiles.filter((f) => f === 'package.json' || f.endsWith('/package.json'));

  for (const rel of pkgJsonFiles) {
    try {
      const content = fs.readFileSync(path.join(cwd, rel), 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.name === 'string') {
        pkgNames.add(parsed.name);
      }
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = parsed[field];
        if (deps && typeof deps === 'object') {
          for (const depName of Object.keys(deps as Record<string, unknown>)) {
            pkgNames.add(depName);
          }
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }
  return pkgNames;
}

function isScopedNpmPackage(rawImport: string, knownPackages: Set<string>, cwd: string): boolean {
  if (knownPackages.has(rawImport)) return true;
  // Also check if rawImport is @scope/pkg/subpath of a known package
  const parts = rawImport.split('/');
  if (parts.length >= 2 && parts[0].startsWith('@')) {
    const scopePkg = `${parts[0]}/${parts[1]}`;
    if (knownPackages.has(scopePkg)) return true;

    // If it's a 2-segment @scope/pkg with no file extension and no corresponding top-level directory in the repo
    const hasExtension = /\.[A-Za-z0-9]+$/.test(parts[parts.length - 1]);
    const topDir = parts[0].slice(1);
    if (
      parts.length === 2 &&
      !hasExtension &&
      topDir !== '.' &&
      topDir !== '..' &&
      !fs.existsSync(path.join(cwd, topDir))
    ) {
      return true;
    }
  }
  return false;
}

function resolveExistingImportTarget(cwd: string, sourceFile: string, targetPath: string): string | null {
  const fromRoot = path.resolve(cwd, targetPath);
  if (fs.existsSync(fromRoot) && fs.statSync(fromRoot).isFile()) {
    return toPosixPath(path.relative(cwd, fromRoot));
  }
  const sourceDir = path.dirname(path.resolve(cwd, sourceFile));
  const fromSourceDir = path.resolve(sourceDir, targetPath);
  if (fs.existsSync(fromSourceDir) && fs.statSync(fromSourceDir).isFile()) {
    return toPosixPath(path.relative(cwd, fromSourceDir));
  }
  return null;
}

export function runImportsPass(ctx: WorkspaceContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const knownPackages = collectWorkspacePackageNames(ctx.cwd, ctx.repoFiles);

  const importsByFile = new Map<string, ImportRef[]>();
  for (const hf of ctx.harnessFiles) {
    importsByFile.set(hf.path, hf.imports);
  }

  const getImportsForFile = (relPath: string): ImportRef[] => {
    const cached = importsByFile.get(relPath);
    if (cached) return cached;
    const abs = path.resolve(ctx.cwd, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return [];
    const content = fs.readFileSync(abs, 'utf8');
    const extracted = extractImportsFromLines(
      relPath,
      content,
      {
        fileSuppressedCodes: new Set(),
        fileOverrideGlobs: new Set(),
        lineSuppressedCodes: new Map(),
        lineOverrideGlobs: new Map(),
        syncMarkersByLine: new Map(),
      },
      0,
    );
    importsByFile.set(relPath, extracted);
    return extracted;
  };

  // 1. Check all direct imports in Harness Files for broken targets
  const adjacency = new Map<string, Array<{ target: string; ref: ImportRef }>>();

  const queue: string[] = ctx.harnessFiles.map((f) => f.path);
  const visitedFilesForGraph = new Set<string>();

  while (queue.length > 0) {
    const currentFile = queue.shift()!;
    if (visitedFilesForGraph.has(currentFile)) continue;
    visitedFilesForGraph.add(currentFile);

    const fileImports = getImportsForFile(currentFile);
    const edges: Array<{ target: string; ref: ImportRef }> = [];

    for (const imp of fileImports) {
      if (isScopedNpmPackage(imp.rawImport, knownPackages, ctx.cwd)) {
        continue;
      }

      const resolvedTarget = resolveExistingImportTarget(ctx.cwd, imp.sourceFile, imp.targetPath);
      if (!resolvedTarget) {
        if (!imp.suppressedCodes.includes('CTX006')) {
          diagnostics.push({
            code: 'CTX006',
            severity: 'error',
            message: `Broken @import target '${imp.rawImport}': file '${imp.targetPath}' does not exist in workspace.`,
            primaryLocation: {
              file: imp.sourceFile,
              lineStart: imp.lineStart,
              lineEnd: imp.lineEnd,
              columnStart: imp.columnStart,
              columnEnd: imp.columnEnd,
              label: `target '${imp.targetPath}' not found`,
            },
            help: `Remove or update '${imp.rawImport}' to point to an existing file in the repository.`,
          });
        }
      } else {
        edges.push({ target: resolvedTarget, ref: imp });
        if (!visitedFilesForGraph.has(resolvedTarget)) {
          queue.push(resolvedTarget);
        }
      }
    }

    adjacency.set(currentFile, edges);
  }

  // 2. Detect circular include chains via DFS
  const reportedCycles = new Set<string>();

  for (const startNode of adjacency.keys()) {
    const stack: string[] = [startNode];
    const edgeStack: ImportRef[] = [];

    const dfs = (current: string) => {
      const edges = adjacency.get(current) ?? [];
      for (const { target, ref } of edges) {
        const cycleStartIndex = stack.indexOf(target);
        if (cycleStartIndex !== -1) {
          const cycleNodes = [...stack.slice(cycleStartIndex), target];
          // Canonicalize cycle key so the same cycle isn't reported multiple times
          const ring = cycleNodes.slice(0, -1);
          const minNode = [...ring].sort()[0];
          const minIdx = ring.indexOf(minNode);
          const canonicalKey = [...ring.slice(minIdx), ...ring.slice(0, minIdx)].join('->');

          if (!reportedCycles.has(canonicalKey)) {
            reportedCycles.add(canonicalKey);
            const firstEdge = edgeStack[cycleStartIndex] ?? ref;
            if (!firstEdge.suppressedCodes.includes('CTX006')) {
              diagnostics.push({
                code: 'CTX006',
                severity: 'error',
                message: `Circular @import include chain detected: ${cycleNodes.join(' -> ')}`,
                primaryLocation: {
                  file: firstEdge.sourceFile,
                  lineStart: firstEdge.lineStart,
                  lineEnd: firstEdge.lineEnd,
                  columnStart: firstEdge.columnStart,
                  columnEnd: firstEdge.columnEnd,
                  label: 'circular @import starts here',
                },
                help: `Break the circular include dependency between ${cycleNodes.join(' and ')}.`,
              });
            }
          }
        } else if (!stack.includes(target)) {
          stack.push(target);
          edgeStack.push(ref);
          dfs(target);
          stack.pop();
          edgeStack.pop();
        }
      }
    };

    dfs(startNode);
  }

  return diagnostics;
}
