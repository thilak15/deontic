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

function buildAncestorExclusionFixForGlobs(
  cwd: string,
  ancestor: DirectiveNode,
  childPositiveGlobs: string[],
): Diagnostic['fix'] | undefined {
  const uniqueGlobs = Array.from(new Set(childPositiveGlobs)).filter(Boolean);
  if (uniqueGlobs.length === 0) return undefined;

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
  const scopeText = uniqueGlobs.join(', ');
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

function buildAncestorExclusionFix(
  cwd: string,
  ancestor: DirectiveNode,
  child: DirectiveNode,
): Diagnostic['fix'] | undefined {
  const childPositiveGlobs = child.effectiveGlobs.filter((g) => !g.startsWith('!'));
  return buildAncestorExclusionFixForGlobs(cwd, ancestor, childPositiveGlobs);
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
          rawOccurrenceCount: 1,
          witnessPath,
          suggestion: `Scope ${ancestor.sourceFile}:${ancestor.lineStart} to exclude ${childScopeDesc} or add <!-- deontic-override: ${childScopeDesc} -->.`,
          help: `Because ${ancestor.sourceFile} is unconditionally loaded at Turn 0, the agent sees both conflicting directives simultaneously when editing ${witnessPath}.`,
          fix,
          metadata: {
            groupKey: `CTX003::${ancestor.sourceFile}:${ancestor.lineStart}::${a.topic}`,
            ancestorDirective: ancestor,
            childPositiveGlobs: child.effectiveGlobs.filter((g) => !g.startsWith('!')),
          },
        };
      }

      const isHard = a.strength === 'HARD' && b.strength === 'HARD';
      const severity = isHard ? 'error' : 'warning';

      // Canonicalize primary vs secondary for CTX001 so root non-dotfile Harness Files anchor the Diagnostic Group
      const aRootNonDot = dA.isAlwaysLoadedAtRoot && !dA.sourceFile.startsWith('.');
      const bRootNonDot = dB.isAlwaysLoadedAtRoot && !dB.sourceFile.startsWith('.');
      const [primaryD, secondaryD] =
        !aRootNonDot && bRootNonDot
          ? [dB, dA]
          : !dA.isAlwaysLoadedAtRoot && dB.isAlwaysLoadedAtRoot
            ? [dB, dA]
            : [dA, dB];

      return {
        code: 'CTX001',
        severity,
        message: `Same-Scope Contradiction (${conflict.reason}) on witness path '${witnessPath}' between ${primaryD.sourceFile}:${primaryD.lineStart} and ${secondaryD.sourceFile}:${secondaryD.lineStart}`,
        primaryLocation: makeDirectiveLocation(primaryD, `${primaryD.modality}: "${primaryD.rawText}"`),
        secondaryLocations: [
          makeDirectiveLocation(secondaryD, `${secondaryD.modality}: "${secondaryD.rawText}"`),
        ],
        rawOccurrenceCount: 1,
        witnessPath,
        suggestion: `Resolve the conflicting ${a.topic} directives or scope them to disjoint file globs.`,
        help: `Both directives apply simultaneously to '${witnessPath}'.`,
        metadata: {
          groupKey: `CTX001::${a.topic}::${a.action}::${severity}`,
          directiveA: primaryD,
          directiveB: secondaryD,
          conflictReason: conflict.reason,
          topic: a.topic,
        },
      };
    }
  }

  return null;
}

function isDirectiveSuppressed(
  d: DirectiveNode,
  code: 'CTX001' | 'CTX003',
  fileMap: Map<string, HarnessFile>,
): boolean {
  if (d.suppressedCodes.includes(code)) return true;
  const hf = fileMap.get(d.sourceFile);
  if (!hf) return false;
  if (hf.suppressedCodes.includes(code)) return true;
  const sec = hf.sections.find((s) => s.id === d.sectionId);
  if (sec?.suppressedCodes.includes(code)) return true;
  return false;
}

export function runContradictionPass(ctx: WorkspaceContext): Diagnostic[] {
  const rawDiagnostics: Diagnostic[] = [];
  const fileMap = new Map<string, HarnessFile>(ctx.harnessFiles.map((f) => [f.path, f]));
  const allDirectives: DirectiveNode[] = [];

  for (const hf of ctx.harnessFiles) {
    if (
      ctx.options.agent &&
      hf.agentProfiles.length > 0 &&
      !hf.agentProfiles.includes(ctx.options.agent)
    ) {
      continue;
    }
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
        const code = diag.code as 'CTX001' | 'CTX003';
        if (
          isDirectiveSuppressed(dA, code, fileMap) ||
          isDirectiveSuppressed(dB, code, fileMap)
        ) {
          continue;
        }
        seenPairs.add(pairKey);
        rawDiagnostics.push(diag);
      }
    }
  }

  // Consolidate repeated CTX003 and CTX001 diagnostics into Diagnostic Groups
  const groups = new Map<string, Diagnostic[]>();
  const ctx001Buckets = new Map<string, Diagnostic[]>();
  for (const diag of rawDiagnostics) {
    const key =
      typeof diag.metadata?.groupKey === 'string'
        ? diag.metadata.groupKey
        : `${diag.code}::${diag.primaryLocation.file}:${diag.primaryLocation.lineStart}::${diag.message}`;
    if (diag.code === 'CTX001') {
      const list = ctx001Buckets.get(key) ?? [];
      list.push(diag);
      ctx001Buckets.set(key, list);
    } else {
      const list = groups.get(key) ?? [];
      list.push(diag);
      groups.set(key, list);
    }
  }

  // Within each CTX001 topic+severity bucket, split by connected component of Directive locations
  let compSeq = 0;
  for (const [bucketKey, bucketItems] of ctx001Buckets.entries()) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = parent.get(x) ?? x;
      if (root !== x) {
        root = find(root);
        parent.set(x, root);
      } else if (!parent.has(x)) {
        parent.set(x, x);
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    for (const item of bucketItems) {
      const dA = item.metadata?.directiveA as DirectiveNode | undefined;
      const dB = item.metadata?.directiveB as DirectiveNode | undefined;
      const kA = dA
        ? `${dA.sourceFile}:${dA.lineStart}`
        : `${item.primaryLocation.file}:${item.primaryLocation.lineStart}`;
      const kB = dB
        ? `${dB.sourceFile}:${dB.lineStart}`
        : `${item.secondaryLocations?.[0]?.file ?? ''}:${item.secondaryLocations?.[0]?.lineStart ?? 0}`;
      union(kA, kB);
    }

    for (const item of bucketItems) {
      const dA = item.metadata?.directiveA as DirectiveNode | undefined;
      const kA = dA
        ? `${dA.sourceFile}:${dA.lineStart}`
        : `${item.primaryLocation.file}:${item.primaryLocation.lineStart}`;
      const root = find(kA);
      const compKey = `${bucketKey}::${root}::${compSeq}`;
      // Use deterministic key without compSeq
      const detKey = `${bucketKey}::${root}`;
      void compKey;
      const list = groups.get(detKey) ?? [];
      list.push(item);
      groups.set(detKey, list);
    }
    compSeq += 1;
  }

  const consolidated: Diagnostic[] = [];
  for (const items of groups.values()) {
    const first = items[0];
    if (items.length === 1) {
      consolidated.push(first);
      continue;
    }

    if (first.code === 'CTX003') {
      const secondaryLocations: DiagnosticLocation[] = [];
      const seenLocs = new Set<string>();
      for (const item of items) {
        for (const sec of item.secondaryLocations ?? []) {
          const locKey = `${sec.file}:${sec.lineStart}:${sec.columnStart}`;
          if (!seenLocs.has(locKey)) {
            seenLocs.add(locKey);
            secondaryLocations.push(sec);
          }
        }
      }

      const ancestor = first.metadata?.ancestorDirective as DirectiveNode | undefined;
      const allChildGlobs: string[] = [];
      for (const item of items) {
        const globs = (item.metadata?.childPositiveGlobs as string[] | undefined) ?? [];
        allChildGlobs.push(...globs);
      }
      const uniqueScopeDesc = Array.from(new Set(allChildGlobs)).join(', ');
      const mergedFix = ancestor
        ? buildAncestorExclusionFixForGlobs(ctx.cwd, ancestor, allChildGlobs)
        : first.fix;

      consolidated.push({
        ...first,
        message: `${first.message} (and ${items.length - 1} other child override(s) in ${uniqueScopeDesc})`,
        secondaryLocations,
        rawOccurrenceCount: items.length,
        suggestion: `Scope ${first.primaryLocation.file}:${first.primaryLocation.lineStart} to exclude ${uniqueScopeDesc} or add <!-- deontic-override -->.`,
        fix: mergedFix,
      });
    } else {
      // CTX001 group: pick the Directive with the highest conflict degree in the group as primaryLocation
      const degree = new Map<string, { count: number; directive: DirectiveNode }>();
      const bump = (d?: DirectiveNode) => {
        if (!d) return;
        const k = `${d.sourceFile}:${d.lineStart}`;
        const cur = degree.get(k);
        if (cur) cur.count += 1;
        else degree.set(k, { count: 1, directive: d });
      };
      for (const item of items) {
        bump(item.metadata?.directiveA as DirectiveNode | undefined);
        bump(item.metadata?.directiveB as DirectiveNode | undefined);
      }
      const sortedNodes = Array.from(degree.values()).sort(
        (a, b) =>
          b.count - a.count ||
          a.directive.sourceFile.localeCompare(b.directive.sourceFile) ||
          a.directive.lineStart - b.directive.lineStart,
      );
      const anchor = sortedNodes[0]?.directive;
      const others = sortedNodes.slice(1).map((n) => n.directive);

      if (anchor && others.length > 0) {
        consolidated.push({
          ...first,
          message: `${first.message} (and ${items.length - 1} other conflicting directive(s))`,
          primaryLocation: makeDirectiveLocation(anchor, `${anchor.modality}: "${anchor.rawText}"`),
          secondaryLocations: others.map((d) =>
            makeDirectiveLocation(d, `${d.modality}: "${d.rawText}"`),
          ),
          rawOccurrenceCount: items.length,
        });
      } else {
        consolidated.push({
          ...first,
          rawOccurrenceCount: items.length,
        });
      }
    }
  }

  return consolidated;
}
