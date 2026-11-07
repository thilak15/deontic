import type { AnalyzeOptions, Diagnostic, WorkspaceAnalysisResult, WorkspaceContext } from '../types.js';
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

export async function analyzeWorkspace(options: AnalyzeOptions): Promise<WorkspaceAnalysisResult> {
  const config = loadWorkspaceConfig(options.cwd, options.config);
  const discovered = discoverWorkspaceFiles(options.cwd, config);

  const ctx: WorkspaceContext = {
    cwd: options.cwd,
    config,
    harnessFiles: discovered.harnessFiles,
    repoFiles: discovered.repoFiles,
    gitignorePatterns: discovered.gitignorePatterns,
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

  return {
    cwd: options.cwd,
    harnessFiles: discovered.harnessFiles,
    repoFiles: discovered.repoFiles,
    diagnostics,
    appliedFixes,
    config,
  };
}
