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
    for (const d of hf.directives) {
      allDirectives.push(d);
    }
  }

  const seenLinePairs = new Set<string>();

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

      const witnessPath = findWitnessIntersection(
        dA.effectiveGlobs,
        dB.effectiveGlobs,
        ctx.repoFiles,
      );
      if (!witnessPath) continue;

      const assertionsA = extractCanonicalAssertions(dA);
      const assertionsB = extractCanonicalAssertions(dB);

      let isSemanticDuplicate = false;
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

      const lineKey = `${dA.sourceFile}:${dA.lineStart}::${dB.sourceFile}:${dB.lineStart}`;
      if (seenLinePairs.has(lineKey)) continue;
      seenLinePairs.add(lineKey);

      // Prefer keeping the root file (e.g. CLAUDE.md / AGENTS.md) as the original and flagging the secondary/rule file as redundant
      const [orig, dup] =
        !fileA.isAlwaysLoadedAtRoot && fileB.isAlwaysLoadedAtRoot
          ? [dB, dA]
          : dA.sourceFile.startsWith('.') && !dB.sourceFile.startsWith('.')
            ? [dB, dA]
            : [dA, dB];

      diagnostics.push({
        code: 'CTX008',
        severity: 'warning',
        agentProfile: sharedProfiles[0],
        message: `Redundant Directive within Agent Profile '${sharedProfiles[0]}': ${dup.sourceFile}:${dup.lineStart} duplicates ${orig.sourceFile}:${orig.lineStart}`,
        primaryLocation: makeLocation(dup, 'Redundant / duplicate directive'),
        secondaryLocations: [makeLocation(orig, 'Original directive')],
        witnessPath,
        suggestion: `Remove the duplicate directive in ${dup.sourceFile}:${dup.lineStart} to save Turn-0 tokens and instruction slots.`,
      });
    }
  }

  return diagnostics;
}
