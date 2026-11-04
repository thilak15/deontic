import type { DiagnosticLocation, WorkspaceAnalysisResult } from '@deontic/core';

function renderLocationFrame(
  loc: DiagnosticLocation,
  prefixArrow: string,
  fileLinesMap: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  const lineNumStr = String(loc.lineStart);
  const pad = ' '.repeat(lineNumStr.length);
  out.push(`${pad}${prefixArrow} ${loc.file}:${loc.lineStart}:${loc.columnStart}`);

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

export function formatPretty(result: WorkspaceAnalysisResult): string {
  const fileLinesMap = new Map<string, string[]>();
  for (const hf of result.harnessFiles) {
    fileLinesMap.set(hf.path, hf.rawContent.split(/\r?\n/));
  }

  const lines: string[] = [];

  for (const diag of result.diagnostics) {
    lines.push(`${diag.severity}[${diag.code}]: ${diag.message}`);
    lines.push(...renderLocationFrame(diag.primaryLocation, '-->', fileLinesMap));

    if (diag.secondaryLocations && diag.secondaryLocations.length > 0) {
      for (const sec of diag.secondaryLocations) {
        lines.push(...renderLocationFrame(sec, ':::', fileLinesMap));
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
  }

  const errorCount = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = result.diagnostics.filter((d) => d.severity === 'warning').length;

  lines.push(
    `Checked ${result.harnessFiles.length} harness file(s): ${errorCount} error(s), ${warningCount} warning(s)`,
  );

  return lines.join('\n');
}
