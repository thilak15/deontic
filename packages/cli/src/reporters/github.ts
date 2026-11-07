import type { WorkspaceAnalysisResult } from '@deontic/core';

function escapeGithubCommandValue(val: string): string {
  return val.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function formatGithub(result: WorkspaceAnalysisResult): string {
  return result.diagnostics
    .map((d) => {
      const level = d.severity === 'error' ? 'error' : 'warning';
      const loc = d.primaryLocation;
      const line = Math.max(1, loc.lineStart);
      const col = Math.max(1, loc.columnStart);
      const msg = escapeGithubCommandValue(
        d.suggestion ? `${d.message} (${d.suggestion})` : d.message,
      );
      return `::${level} file=${loc.file},line=${line},col=${col},title=${d.code}::${msg}`;
    })
    .join('\n');
}
