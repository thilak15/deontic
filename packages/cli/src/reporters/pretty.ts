import type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticLocation,
  WorkspaceAnalysisResult,
} from '@deontic/core';

export interface PrettyFormatOptions {
  verbose?: boolean;
}

const MAX_DEFAULT_SECONDARY_LOCATIONS = 5;
const MAX_DEFAULT_WARNING_GROUPS_PER_RULE = 3;

function renderLocationFrame(
  loc: DiagnosticLocation,
  fileLinesMap: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  const lineNumStr = String(loc.lineStart);
  const pad = ' '.repeat(lineNumStr.length);
  out.push(`${pad}--> ${loc.file}:${loc.lineStart}:${loc.columnStart}`);

  const fileLines = fileLinesMap.get(loc.file);
  const lineText = loc.snippet ?? fileLines?.[loc.lineStart - 1];
  if (lineText !== undefined) {
    out.push(`${pad} |`);
    out.push(`${lineNumStr} | ${lineText}`);
    const colOffset = Math.max(0, loc.columnStart - 1);
    const spanLen =
      loc.lineEnd === loc.lineStart && loc.columnEnd > loc.columnStart
        ? loc.columnEnd - loc.columnStart
        : Math.max(1, lineText.trim().length);
    const carets = '^'.repeat(Math.max(1, spanLen));
    const labelSuffix = loc.label ? ` ${loc.label}` : '';
    out.push(`${pad} | ${' '.repeat(colOffset)}${carets}${labelSuffix}`);
  }
  return out;
}

function renderSecondaryPointer(loc: DiagnosticLocation): string {
  const snippet = loc.snippet?.trim();
  const detail =
    loc.label && snippet && !loc.label.includes(snippet)
      ? `${loc.label} (${snippet})`
      : (loc.label ?? snippet);
  return detail
    ? `  ::: ${loc.file}:${loc.lineStart}:${loc.columnStart} — ${detail}`
    : `  ::: ${loc.file}:${loc.lineStart}:${loc.columnStart}`;
}

function renderSummaryTable(result: WorkspaceAnalysisResult): string[] {
  const summary = result.summary;
  const excluded = result.excludedCheckouts ?? [];
  if (result.diagnostics.length === 0 && excluded.length === 0) {
    return [];
  }

  const out: string[] = [];
  out.push('Summary');
  out.push('───────');

  if (summary && summary.byRule.length > 0) {
    const headers = ['Code', 'Severity', 'Grouped Issues', 'Raw Occurrences', 'Fixable'];
    const rows = summary.byRule.map((r) => [
      r.code,
      r.severity,
      String(r.groupedCount),
      String(r.rawCount),
      String(r.fixableCount),
    ]);
    const colWidths = headers.map((h, colIdx) =>
      Math.max(h.length, ...rows.map((row) => row[colIdx].length)),
    );
    const formatRow = (cols: string[]) =>
      `  ${cols.map((c, idx) => (idx >= 2 ? c.padStart(colWidths[idx]) : c.padEnd(colWidths[idx]))).join('  ')}`;

    out.push(formatRow(headers));
    out.push(`  ${colWidths.map((w) => '─'.repeat(w)).join('  ')}`);
    for (const row of rows) {
      out.push(formatRow(row));
    }
    out.push('');
  }

  if (summary) {
    out.push(
      `  Main Checkout Totals: ${summary.groupedErrorCount} error(s), ${summary.groupedWarningCount} warning(s) grouped (${summary.rawErrorCount} raw error(s), ${summary.rawWarningCount} raw warning(s))`,
    );
    out.push(`  Auto-fixable (--fix): ${summary.fixableCount} issue group(s)`);
  }

  if (excluded.length > 0) {
    out.push(`  Excluded Checkout Boundaries (${excluded.length}): ${excluded.join(', ')}`);
  }

  out.push('');
  return out;
}

export function formatPretty(
  result: WorkspaceAnalysisResult,
  options: PrettyFormatOptions = {},
): string {
  const verbose = Boolean(options.verbose);
  const fileLinesMap = new Map<string, string[]>();
  for (const hf of result.harnessFiles) {
    fileLinesMap.set(hf.path, hf.rawContent.split(/\r?\n/));
  }

  const lines: string[] = [];
  const warningGroupsShownByRule = new Map<DiagnosticCode, number>();
  const hiddenWarningsByRule = new Map<
    DiagnosticCode,
    { hiddenGroups: number; hiddenOccurrences: number }
  >();

  const renderDiagnosticGroup = (diag: Diagnostic) => {
    lines.push(`${diag.severity}[${diag.code}]: ${diag.message}`);
    lines.push(...renderLocationFrame(diag.primaryLocation, fileLinesMap));

    const secondaries = diag.secondaryLocations ?? [];
    if (secondaries.length > 0) {
      const visibleSecondaries = verbose
        ? secondaries
        : secondaries.slice(0, MAX_DEFAULT_SECONDARY_LOCATIONS);
      for (const sec of visibleSecondaries) {
        lines.push(renderSecondaryPointer(sec));
      }
      if (!verbose && secondaries.length > MAX_DEFAULT_SECONDARY_LOCATIONS) {
        const remaining = secondaries.length - MAX_DEFAULT_SECONDARY_LOCATIONS;
        lines.push(`  ... and ${remaining} more location(s); pass --verbose to expand`);
      }
    }

    if (diag.witnessPath) {
      lines.push(`  = note: witness path: ${diag.witnessPath}`);
    }
    if (diag.suggestion) {
      lines.push(`  = suggestion: ${diag.suggestion}`);
    }
    if (diag.help) {
      lines.push(`  = help: ${diag.help}`);
    }
    lines.push('');
  };

  for (const diag of result.diagnostics) {
    if (!verbose && diag.severity === 'warning') {
      const shown = warningGroupsShownByRule.get(diag.code) ?? 0;
      if (shown >= MAX_DEFAULT_WARNING_GROUPS_PER_RULE) {
        const hidden = hiddenWarningsByRule.get(diag.code) ?? {
          hiddenGroups: 0,
          hiddenOccurrences: 0,
        };
        hidden.hiddenGroups += 1;
        hidden.hiddenOccurrences += diag.rawOccurrenceCount ?? 1;
        hiddenWarningsByRule.set(diag.code, hidden);
        continue;
      }
      warningGroupsShownByRule.set(diag.code, shown + 1);
    }

    renderDiagnosticGroup(diag);
  }

  if (!verbose && hiddenWarningsByRule.size > 0) {
    for (const [code, info] of hiddenWarningsByRule.entries()) {
      lines.push(
        `... and ${info.hiddenGroups} more ${code} warning group(s) [${info.hiddenOccurrences} occurrences] hidden; pass --verbose to expand`,
      );
    }
    lines.push('');
  }

  lines.push(...renderSummaryTable(result));

  const errorCount = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = result.diagnostics.filter((d) => d.severity === 'warning').length;

  lines.push(
    `Checked ${result.harnessFiles.length} harness file(s): ${errorCount} error(s), ${warningCount} warning(s)`,
  );

  return lines.join('\n');
}
