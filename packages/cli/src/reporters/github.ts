import type { WorkspaceAnalysisResult } from '@deontic/core';

function escapeGithubCommandValue(val: string): string {
  return val.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function formatGithub(result: WorkspaceAnalysisResult): string {
  const lines: string[] = [];

  for (const d of result.diagnostics) {
    const level = d.severity === 'error' ? 'error' : 'warning';
    const loc = d.primaryLocation;
    const line = Math.max(1, loc.lineStart);
    const col = Math.max(1, loc.columnStart);
    const msg = escapeGithubCommandValue(
      d.suggestion ? `${d.message} (${d.suggestion})` : d.message,
    );
    lines.push(`::${level} file=${loc.file},line=${line},col=${col},title=${d.code}::${msg}`);

    for (const sec of d.secondaryLocations ?? []) {
      const secLine = Math.max(1, sec.lineStart);
      const secCol = Math.max(1, sec.columnStart);
      const secDetail = sec.label ? `${d.message} [${sec.label}]` : d.message;
      lines.push(
        `::${level} file=${sec.file},line=${secLine},col=${secCol},title=${d.code}::${escapeGithubCommandValue(secDetail)}`,
      );
    }
  }

  if (result.summary && (result.diagnostics.length > 0 || result.excludedCheckouts.length > 0)) {
    const s = result.summary;
    const excludedPart =
      s.excludedCheckouts.length > 0
        ? `; excludedCheckouts=${s.excludedCheckouts.join(',')}`
        : '';
    lines.push(
      `::notice title=deontic-summary::grouped=${s.groupedErrorCount} error(s), ${s.groupedWarningCount} warning(s); raw=${s.rawErrorCount} error(s), ${s.rawWarningCount} warning(s); fixable=${s.fixableCount}${excludedPart}`,
    );
  }

  return lines.join('\n');
}
