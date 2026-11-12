import type {
  AgentProfileId,
  Diagnostic,
  DiagnosticLocation,
  DirectiveNode,
  HarnessFile,
  RuleSection,
  WorkspaceContext,
} from '../types.js';
import { findWitnessIntersection } from '../scope/index.js';
import {
  areConditionsCompatible,
  extractCanonicalAssertions,
  modalityPolarity,
} from './ontology.js';

const STOP_WORDS = new Set([
  'must',
  'not',
  'never',
  'always',
  'should',
  'prefer',
  'avoid',
  'do',
  'dont',
  'please',
  'make',
  'sure',
  'to',
  'the',
  'a',
  'an',
  'in',
  'on',
  'for',
  'of',
  'with',
  'and',
  'or',
  'all',
  'every',
  'any',
  'when',
  'before',
  'after',
  'is',
  'are',
  'be',
]);

function tokenizeForSimilarity(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

function computeJaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function makeLocation(d: DirectiveNode, label?: string): DiagnosticLocation {
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

type SectionWorkflowContext =
  | 'summary'
  | 'testing'
  | 'release_pr'
  | 'database'
  | 'frontend'
  | 'backend_api'
  | 'general';

function classifySectionContext(heading?: string): SectionWorkflowContext {
  if (!heading) return 'general';
  const lower = heading.toLowerCase();
  if (
    /\b(?:overview|summary|tl;?dr|quick\s*(?:start|reference|ref)|cheat\s*sheet|at\s+a\s+glance|introduction|intro)\b/.test(
      lower,
    )
  ) {
    return 'summary';
  }
  if (
    /\b(?:pr|pull\s*request|review|release|deploy(?:ment)?|ci|cd|pipeline|commit|pre-commit|git|merge|publish|checklist|ship(?:ping)?)\b/.test(
      lower,
    )
  ) {
    return 'release_pr';
  }
  if (
    /\b(?:test(?:ing|s)?|vitest|jest|playwright|cypress|e2e|unit|integration|spec|qa|verification)\b/.test(
      lower,
    )
  ) {
    return 'testing';
  }
  if (/\b(?:db|database|prisma|drizzle|sql|postgres|migration|schema)\b/.test(lower)) {
    return 'database';
  }
  if (/\b(?:ui|frontend|react|next\.?js|tailwind|css|component|styling)\b/.test(lower)) {
    return 'frontend';
  }
  if (/\b(?:api|backend|server|router|endpoint|trpc|graphql|webhook|auth)\b/.test(lower)) {
    return 'backend_api';
  }
  return 'general';
}

function isOnDemandSkillFile(file: HarnessFile): boolean {
  return file.format === 'claude-skill' && !file.isAlwaysLoadedAtRoot;
}

function normalizeSetKey(items: string[]): string {
  return [...items]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
}

function compareCanonicalPriority(
  dA: DirectiveNode,
  dB: DirectiveNode,
  fileMap: Map<string, HarnessFile>,
): number {
  const fileA = fileMap.get(dA.sourceFile);
  const fileB = fileMap.get(dB.sourceFile);
  const aRoot = Boolean(fileA?.isAlwaysLoadedAtRoot) && !dA.sourceFile.startsWith('.');
  const bRoot = Boolean(fileB?.isAlwaysLoadedAtRoot) && !dB.sourceFile.startsWith('.');
  if (aRoot !== bRoot) return aRoot ? -1 : 1;

  const aAlways = Boolean(fileA?.isAlwaysLoadedAtRoot);
  const bAlways = Boolean(fileB?.isAlwaysLoadedAtRoot);
  if (aAlways !== bAlways) return aAlways ? -1 : 1;

  const aDot = dA.sourceFile.startsWith('.');
  const bDot = dB.sourceFile.startsWith('.');
  if (aDot !== bDot) return aDot ? 1 : -1;

  const fileCmp = dA.sourceFile.localeCompare(dB.sourceFile);
  if (fileCmp !== 0) return fileCmp;
  return dA.lineStart - dB.lineStart;
}

export function runRedundancyPass(ctx: WorkspaceContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fileMap = new Map<string, HarnessFile>(ctx.harnessFiles.map((f) => [f.path, f]));
  const sectionMap = new Map<string, RuleSection>();

  for (const hf of ctx.harnessFiles) {
    for (const sec of hf.sections) {
      sectionMap.set(sec.id, sec);
    }
  }

  const allDirectives: DirectiveNode[] = [];
  for (const hf of ctx.harnessFiles) {
    if (hf.suppressedCodes.includes('CTX008')) continue;
    if (
      ctx.options.agent &&
      hf.agentProfiles.length > 0 &&
      !hf.agentProfiles.includes(ctx.options.agent)
    ) {
      continue;
    }
    for (const d of hf.directives) {
      if (d.suppressedCodes.includes('CTX008')) continue;
      const sec = sectionMap.get(d.sectionId);
      if (sec?.suppressedCodes.includes('CTX008')) continue;
      allDirectives.push(d);
    }
  }

  interface DuplicateEdge {
    idxA: number;
    idxB: number;
    witnessPath: string;
  }

  const edgesByProfile = new Map<AgentProfileId, DuplicateEdge[]>();
  const seenProfileLinePairs = new Set<string>();

  for (let i = 0; i < allDirectives.length; i++) {
    for (let j = i + 1; j < allDirectives.length; j++) {
      const dA = allDirectives[i];
      const dB = allDirectives[j];

      if (dA.sourceFile === dB.sourceFile && dA.lineStart === dB.lineStart) {
        continue;
      }

      const fileA = fileMap.get(dA.sourceFile);
      const fileB = fileMap.get(dB.sourceFile);
      if (!fileA || !fileB) continue;

      // Exempt on-demand SKILL.md files from cross-file redundancy checks
      if (dA.sourceFile !== dB.sourceFile && (isOnDemandSkillFile(fileA) || isOnDemandSkillFile(fileB))) {
        continue;
      }

      // Skip sections managed by `deontic:sync` markers
      const secA = sectionMap.get(dA.sectionId);
      const secB = sectionMap.get(dB.sectionId);
      if (secA?.syncMarker || secB?.syncMarker) {
        continue;
      }

      // Per ADR-0002: Only check redundancy within the SAME Agent Profile!
      const sharedProfiles: AgentProfileId[] = fileA.agentProfiles.filter((p) =>
        fileB.agentProfiles.includes(p),
      );
      if (sharedProfiles.length === 0) {
        continue;
      }

      if (modalityPolarity(dA.modality) !== modalityPolarity(dB.modality)) {
        continue;
      }

      // Same-file cross-section context check: exempt intentional repetition across distinct workflow/domain sections
      if (dA.sourceFile === dB.sourceFile && dA.sectionId !== dB.sectionId) {
        const condA = dA.predicate.condition ?? '';
        const condB = dB.predicate.condition ?? '';
        if (condA !== condB) {
          continue;
        }
        const ctxA = classifySectionContext(secA?.heading);
        const ctxB = classifySectionContext(secB?.heading);
        if (ctxA !== ctxB) {
          continue;
        }
      }

      const witnessPath = findWitnessIntersection(
        dA.effectiveGlobs,
        dB.effectiveGlobs,
        ctx.repoFiles,
      );
      if (!witnessPath) continue;

      const cmdsA = normalizeSetKey(dA.referencedCommands);
      const cmdsB = normalizeSetKey(dB.referencedCommands);
      const pathsA = normalizeSetKey(dA.referencedPaths);
      const pathsB = normalizeSetKey(dB.referencedPaths);
      const commandsAndPathsCompatible = cmdsA === cmdsB && pathsA === pathsB;

      const assertionsA = extractCanonicalAssertions(dA);
      const assertionsB = extractCanonicalAssertions(dB);

      let isSemanticDuplicate = false;
      if (commandsAndPathsCompatible) {
        for (const a of assertionsA) {
          for (const b of assertionsB) {
            if (
              a.topic !== 'general' &&
              a.topic === b.topic &&
              a.action === b.action &&
              a.target === b.target &&
              a.polarity === b.polarity &&
              areConditionsCompatible(a.condition, b.condition)
            ) {
              isSemanticDuplicate = true;
              break;
            }
          }
          if (isSemanticDuplicate) break;
        }
      }

      let isTextualNearDuplicate = false;
      if (!isSemanticDuplicate) {
        const tokensA = tokenizeForSimilarity(dA.rawText);
        const tokensB = tokenizeForSimilarity(dB.rawText);
        if (tokensA.size >= 2 && tokensB.size >= 2) {
          const sim = computeJaccardSimilarity(tokensA, tokensB);
          if (sim >= 0.75) {
            isTextualNearDuplicate = true;
          }
        }
      }

      if (!isSemanticDuplicate && !isTextualNearDuplicate) {
        continue;
      }

      const profile = sharedProfiles[0];
      const lineKey = `${profile}::${dA.sourceFile}:${dA.lineStart}::${dB.sourceFile}:${dB.lineStart}`;
      if (seenProfileLinePairs.has(lineKey)) continue;
      seenProfileLinePairs.add(lineKey);

      const list = edgesByProfile.get(profile) ?? [];
      list.push({ idxA: i, idxB: j, witnessPath });
      edgesByProfile.set(profile, list);
    }
  }

  // Consolidate connected components of duplicate Directives per Agent Profile into single Diagnostic Groups
  for (const [profile, edges] of edgesByProfile.entries()) {
    if (ctx.options.agent && profile !== ctx.options.agent) {
      continue;
    }
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let root = parent.get(x) ?? x;
      if (root !== x) {
        root = find(root);
        parent.set(x, root);
      } else if (!parent.has(x)) {
        parent.set(x, x);
      }
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    for (const edge of edges) {
      union(edge.idxA, edge.idxB);
    }

    const diagnosticGroups = new Map<
      number,
      { memberIndices: Set<number>; rawPairCount: number; witnessPath: string }
    >();
    for (const edge of edges) {
      const root = find(edge.idxA);
      const existing = diagnosticGroups.get(root);
      if (existing) {
        existing.memberIndices.add(edge.idxA);
        existing.memberIndices.add(edge.idxB);
        existing.rawPairCount += 1;
      } else {
        diagnosticGroups.set(root, {
          memberIndices: new Set([edge.idxA, edge.idxB]),
          rawPairCount: 1,
          witnessPath: edge.witnessPath,
        });
      }
    }

    for (const group of diagnosticGroups.values()) {
      // Deduplicate Directives that live on the same file:line within the Diagnostic Group
      const byFileLine = new Map<string, DirectiveNode>();
      for (const idx of group.memberIndices) {
        const d = allDirectives[idx];
        const key = `${d.sourceFile}:${d.lineStart}`;
        if (!byFileLine.has(key)) {
          byFileLine.set(key, d);
        }
      }
      const members = Array.from(byFileLine.values()).sort((a, b) =>
        compareCanonicalPriority(a, b, fileMap),
      );
      if (members.length < 2) continue;

      const orig = members[0];
      const duplicates = members.slice(1);
      const primaryDup = duplicates[0];
      const extraDups = duplicates.slice(1);

      const secondaryLocations: DiagnosticLocation[] = [
        makeLocation(orig, 'Original directive'),
        ...extraDups.map((d) => makeLocation(d, 'Redundant / duplicate directive')),
      ];

      const extraSuffix =
        extraDups.length > 0 ? ` (and ${extraDups.length} other location(s))` : '';

      diagnostics.push({
        code: 'CTX008',
        severity: 'warning',
        agentProfile: profile,
        message: `Redundant Directive within Agent Profile '${profile}': ${primaryDup.sourceFile}:${primaryDup.lineStart} duplicates ${orig.sourceFile}:${orig.lineStart}${extraSuffix}`,
        primaryLocation: makeLocation(primaryDup, 'Redundant / duplicate directive'),
        secondaryLocations,
        rawOccurrenceCount: group.rawPairCount,
        witnessPath: group.witnessPath,
        suggestion:
          extraDups.length > 0
            ? `Remove the ${duplicates.length} duplicate directives (${duplicates.map((d) => `${d.sourceFile}:${d.lineStart}`).join(', ')}) to save Turn-0 tokens and instruction slots.`
            : `Remove the duplicate directive in ${primaryDup.sourceFile}:${primaryDup.lineStart} to save Turn-0 tokens and instruction slots.`,
      });
    }
  }

  return diagnostics;
}
