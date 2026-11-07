import fs from 'node:fs';
import path from 'node:path';
import type {
  Diagnostic,
  DiagnosticLocation,
  DirectiveNode,
  HarnessFile,
  WorkspaceContext,
} from '../types.js';
import { findWitnessIntersection, isUniversalRootGlobSet } from '../scope/index.js';
import {
  doAssertionsConflict,
  extractCanonicalAssertions,
  type CanonicalAssertion,
} from './ontology.js';

function makeDirectiveLocation(d: DirectiveNode, label?: string): DiagnosticLocation {
  return {
    file: d.sourceFile,
    lineStart: d.lineStart,
    lineEnd: d.lineEnd,
    columnStart: d.columnStart,
    columnEnd: d.columnEnd,
    snippet: d.rawText,
    label,
  };
}

function buildEffectiveGlobsWithExclusions(
  d: DirectiveNode,
  assertion: CanonicalAssertion,
): string[] {
  const globs = [...d.effectiveGlobs];
  for (const excl of assertion.excludedPaths) {
    const clean = excl.replace(/^!+/, '').trim();
    if (!clean) continue;
    if (clean.includes('*')) {
      globs.push(`!${clean}`);
    } else {
      const trimmed = clean.replace(/\/+$/, '');
      globs.push(`!${trimmed}`);
      globs.push(`!${trimmed}/**`);
    }
  }
  return globs;
}

function isChildOverrideHandledByPragma(
  ancestor: DirectiveNode,
  child: DirectiveNode,
  childFile?: HarnessFile,
): boolean {
  const allOverrides = [
    ...child.overrideGlobs,
    ...(childFile?.overrideGlobs ?? []),
  ];
  if (allOverrides.includes('**/*') || allOverrides.includes('**') || allOverrides.includes('*')) {
    return true;
  }
  for (const ov of allOverrides) {
    if (child.effectiveGlobs.includes(ov) || ancestor.sourceFile === ov) {
      return true;
    }
  }
  return false;
}

function isAncestorChildRelationship(
  dA: DirectiveNode,
  dB: DirectiveNode,
): { ancestor: DirectiveNode; child: DirectiveNode } | null {
  if (dA.sourceFile === dB.sourceFile) return null;

  const aIsRootUniversal = dA.isAlwaysLoadedAtRoot && isUniversalRootGlobSet(dA.effectiveGlobs);
  const bIsRootUniversal = dB.isAlwaysLoadedAtRoot && isUniversalRootGlobSet(dB.effectiveGlobs);

  if (aIsRootUniversal && !dB.isAlwaysLoadedAtRoot && !bIsRootUniversal) {
    return { ancestor: dA, child: dB };
  }
  if (bIsRootUniversal && !dA.isAlwaysLoadedAtRoot && !aIsRootUniversal) {
    return { ancestor: dB, child: dA };
  }
  return null;
}

function buildAncestorExclusionFix(
  cwd: string,
  ancestor: DirectiveNode,
  child: DirectiveNode,
): Diagnostic['fix'] | undefined {
  const childPositiveGlobs = child.effectiveGlobs.filter((g) => !g.startsWith('!'));
  if (childPositiveGlobs.length === 0) return undefined;

  const absPath = path.resolve(cwd, ancestor.sourceFile);
  let fileContent = '';
  try {
    fileContent = fs.readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }

  const lines = fileContent.split(/\r?\n/);
  const targetLineIdx = ancestor.lineStart - 1;
  if (targetLineIdx < 0 || targetLineIdx >= lines.length) return undefined;

  const originalLine = lines[targetLineIdx];
  const scopeText = childPositiveGlobs.join(', ');
  if (originalLine.includes(`except in ${scopeText}`)) {
    return undefined;
  }

  const trimmedRight = originalLine.replace(/\s+$/, '');
  const endsWithPeriod = trimmedRight.endsWith('.');
  const newLine = endsWithPeriod
    ? `${trimmedRight.slice(0, -1)} (except in ${scopeText}).`
    : `${trimmedRight} (except in ${scopeText})`;

  return {
    description: `Qualify root directive in ${ancestor.sourceFile}:${ancestor.lineStart} to exclude ${scopeText}`,
    edits: [
      {
        file: ancestor.sourceFile,
        lineStart: ancestor.lineStart,
        lineEnd: ancestor.lineStart,
        oldText: originalLine,
        newText: newLine,
      },
    ],
  };
}

export function evaluateDirectivePair(
  dA: DirectiveNode,
  dB: DirectiveNode,
  repoFiles: string[],
  cwd: string,
  fileMap?: Map<string, HarnessFile>,
): Diagnostic | null {
  if (dA.id === dB.id) return null;
  if (dA.sourceFile === dB.sourceFile && dA.lineStart === dB.lineStart) {
    return null;
  }

  const assertionsA = extractCanonicalAssertions(dA);
  const assertionsB = extractCanonicalAssertions(dB);

  for (const a of assertionsA) {
    for (const b of assertionsB) {
      const conflict = doAssertionsConflict(a, b);
      if (!conflict.conflicts) continue;

      const globsA = buildEffectiveGlobsWithExclusions(dA, a);
      const globsB = buildEffectiveGlobsWithExclusions(dB, b);

      const witnessPath = findWitnessIntersection(globsA, globsB, repoFiles);
      if (!witnessPath) continue;

      const ancestorChild = isAncestorChildRelationship(dA, dB);
      if (ancestorChild) {
        const { ancestor, child } = ancestorChild;
        const childFile = fileMap?.get(child.sourceFile);
        if (isChildOverrideHandledByPragma(ancestor, child, childFile)) {
          continue;
        }

        const childScopeDesc = child.effectiveGlobs.filter((g) => !g.startsWith('!')).join(', ');
        const fix = buildAncestorExclusionFix(cwd, ancestor, child);

        return {
          code: 'CTX003',
          severity: 'warning',
          message: `Unscoped Ancestor Override in scope ${childScopeDesc}: child directive in ${child.sourceFile}:${child.lineStart} reverses always-loaded root directive in ${ancestor.sourceFile}:${ancestor.lineStart} (witness: ${witnessPath})`,
          primaryLocation: makeDirectiveLocation(
            ancestor,
            `Always-loaded ancestor directive (${ancestor.modality})`,
          ),
          secondaryLocations: [
            makeDirectiveLocation(
              child,
              `Narrower child directive in ${childScopeDesc} (${child.modality})`,
            ),
          ],
          witnessPath,
          suggestion: `Scope ${ancestor.sourceFile}:${ancestor.lineStart} to exclude ${childScopeDesc} or add <!-- deontic-override: ${childScopeDesc} -->.`,
          help: `Because ${ancestor.sourceFile} is unconditionally loaded at Turn 0, the agent sees both conflicting directives simultaneously when editing ${witnessPath}.`,
          fix,
        };
      }

      const isHard = a.strength === 'HARD' && b.strength === 'HARD';
      const severity = isHard ? 'error' : 'warning';

      return {
        code: 'CTX001',
        severity,
        message: `Same-Scope Contradiction (${conflict.reason}) on witness path '${witnessPath}' between ${dA.sourceFile}:${dA.lineStart} and ${dB.sourceFile}:${dB.lineStart}`,
        primaryLocation: makeDirectiveLocation(dA, `${dA.modality}: "${dA.rawText}"`),
        secondaryLocations: [makeDirectiveLocation(dB, `${dB.modality}: "${dB.rawText}"`)],
        witnessPath,
        suggestion: `Resolve the conflicting ${a.topic} directives or scope them to disjoint file globs.`,
        help: `Both directives apply simultaneously to '${witnessPath}'.`,
      };
    }
  }

  return null;
}

export function runContradictionPass(ctx: WorkspaceContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fileMap = new Map<string, HarnessFile>(ctx.harnessFiles.map((f) => [f.path, f]));
  const allDirectives: DirectiveNode[] = [];

  for (const hf of ctx.harnessFiles) {
    for (const d of hf.directives) {
      allDirectives.push(d);
    }
  }

  const seenPairs = new Set<string>();

  for (let i = 0; i < allDirectives.length; i++) {
    for (let j = i + 1; j < allDirectives.length; j++) {
      const dA = allDirectives[i];
      const dB = allDirectives[j];

      const pairKey = `${dA.id}::${dB.id}`;
      if (seenPairs.has(pairKey)) continue;

      const diag = evaluateDirectivePair(dA, dB, ctx.repoFiles, ctx.cwd, fileMap);
      if (diag) {
        seenPairs.add(pairKey);
        diagnostics.push(diag);
      }
    }
  }

  return diagnostics;
}
