import type { WorkspaceAnalysisResult } from '@deontic/core';

export function formatGithub(result: WorkspaceAnalysisResult): string {
  return result.diagnostics
    .map((d) => {
      const level = d.severity === 'error' ? 'error' : 'warning';
      const loc = d.primaryLocation;
      return `::${level} file=${loc.file},line=${loc.lineStart},col=${loc.columnStart},title=${d.code}::${d.message}`;
    })
    .join('\n');
}
