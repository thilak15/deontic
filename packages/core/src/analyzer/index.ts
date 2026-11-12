import type {
  AnalyzeOptions,
  Diagnostic,
  DiagnosticCode,
  RuleDiagnosticSummary,
  WorkspaceAnalysisResult,
  WorkspaceAnalysisSummary,
  WorkspaceContext,
} from '../types.js';
import { loadWorkspaceConfig } from '../config/index.js';
import { discoverWorkspaceFiles } from '../discovery/index.js';
import { applyFixesToWorkspace } from '../autofix/index.js';
import { runImportsPass } from './00-imports.js';
import { runContradictionPass } from './01-contradiction.js';
import { runGroundTruthPass } from './02-ground-truth.js';
import { runBloatCliffPass } from './03-bloat-cliff.js';
import { runMcpSchemaPass, probeMcpServers } from './04-mcp-schema.js';
import { runRedundancyPass } from './05-redundancy.js';
import { runTraceRoiPass } from './06-trace-roi.js';

export function filterAndMapDiagnostics(
  rawDiagnostics: Diagnostic[],
  ctx: WorkspaceContext,
): Diagnostic[] {
  const fileMap = new Map(ctx.harnessFiles.map((f) => [f.path, f]));
  const result: Diagnostic[] = [];

  for (const diag of rawDiagnostics) {
    // 1. Check rule config override ('off' | 'warn' | 'warning' | 'error')
    const ruleSetting = ctx.config.rules[diag.code];
    if (ruleSetting === 'off') {
      continue;
    }

    // 2. Check agent profile filter if options.agent is specified
    if (ctx.options.agent) {
      if (diag.agentProfile && diag.agentProfile !== ctx.options.agent) {
        continue;
      }
      const hf = fileMap.get(diag.primaryLocation.file);
      if (hf && hf.agentProfiles.length > 0 && !hf.agentProfiles.includes(ctx.options.agent)) {
        continue;
      }
    }

    // 3. Check inline pragma suppressions on file / section / directive
    const hf = fileMap.get(diag.primaryLocation.file);
    if (hf) {
      if (hf.suppressedCodes.includes(diag.code)) {
        continue;
      }
      const line = diag.primaryLocation.lineStart;
      const matchingDirective = hf.directives.find(
        (d) => line >= d.lineStart && line <= d.lineEnd && d.suppressedCodes.includes(diag.code),
      );
      if (matchingDirective) {
        continue;
      }
      const matchingNote = hf.contextNotes.find(
        (n) => line >= n.lineStart && line <= n.lineEnd && n.suppressedCodes.includes(diag.code),
      );
      if (matchingNote) {
        continue;
      }
      const matchingSection = hf.sections.find(
        (s) => line >= s.lineStart && line <= s.lineEnd && s.suppressedCodes.includes(diag.code),
      );
      if (matchingSection) {
        continue;
      }
    }

    const mappedSeverity =
      ruleSetting === 'warn' || ruleSetting === 'warning'
        ? 'warning'
        : ruleSetting === 'error'
          ? 'error'
          : diag.severity;

    result.push({
      ...diag,
      severity: mappedSeverity,
    });
  }

  return result;
}

export function buildAnalysisSummary(
  diagnostics: Diagnostic[],
  excludedCheckouts: string[],
): WorkspaceAnalysisSummary {
  let groupedErrorCount = 0;
  let groupedWarningCount = 0;
  let rawErrorCount = 0;
  let rawWarningCount = 0;
  let fixableCount = 0;

  const byRuleMap = new Map<string, RuleDiagnosticSummary>();

  for (const diag of diagnostics) {
    const rawCount = diag.rawOccurrenceCount ?? 1;
    const isFixable = Boolean(diag.fix && diag.fix.edits.length > 0);
    if (isFixable) {
      fixableCount += 1;
    }
    if (diag.severity === 'error') {
      groupedErrorCount += 1;
      rawErrorCount += rawCount;
    } else {
      groupedWarningCount += 1;
      rawWarningCount += rawCount;
    }

    const key = `${diag.code}::${diag.severity}`;
    const existing = byRuleMap.get(key);
    if (existing) {
      existing.groupedCount += 1;
      existing.rawCount += rawCount;
      if (isFixable) existing.fixableCount += 1;
    } else {
      byRuleMap.set(key, {
        code: diag.code as DiagnosticCode,
        severity: diag.severity,
        groupedCount: 1,
        rawCount,
        fixableCount: isFixable ? 1 : 0,
      });
    }
  }

  const byRule = Array.from(byRuleMap.values()).sort(
    (a, b) => a.code.localeCompare(b.code) || a.severity.localeCompare(b.severity),
  );

  return {
    groupedErrorCount,
    groupedWarningCount,
    rawErrorCount,
    rawWarningCount,
    fixableCount,
    excludedCheckouts,
    byRule,
  };
}

export async function analyzeWorkspace(options: AnalyzeOptions): Promise<WorkspaceAnalysisResult> {
  const config = loadWorkspaceConfig(options.cwd, options.config);
  const discovered = discoverWorkspaceFiles(options.cwd, config);

  const ctx: WorkspaceContext = {
    cwd: options.cwd,
    config,
    harnessFiles: discovered.harnessFiles,
    repoFiles: discovered.repoFiles,
    gitignorePatterns: discovered.gitignorePatterns,
    excludedCheckouts: discovered.excludedCheckouts,
    options,
  };

  const liveProfiles = options.probe
    ? await probeMcpServers({ cwd: options.cwd })
    : undefined;

  const rawDiagnostics: Diagnostic[] = [
    ...runImportsPass(ctx),
    ...runContradictionPass(ctx),
    ...runGroundTruthPass(ctx),
    ...runBloatCliffPass(ctx),
    ...runMcpSchemaPass(ctx, liveProfiles),
    ...runRedundancyPass(ctx),
    ...runTraceRoiPass(ctx),
  ];

  const diagnostics = filterAndMapDiagnostics(rawDiagnostics, ctx);
  const appliedFixes = options.fix ? applyFixesToWorkspace(options.cwd, diagnostics) : [];
  const summary = buildAnalysisSummary(diagnostics, discovered.excludedCheckouts);

  return {
    cwd: options.cwd,
    harnessFiles: discovered.harnessFiles,
    repoFiles: discovered.repoFiles,
    diagnostics,
    appliedFixes,
    config,
    excludedCheckouts: discovered.excludedCheckouts,
    summary,
  };
}
