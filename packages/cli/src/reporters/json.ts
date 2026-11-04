import type { WorkspaceAnalysisResult } from '@deontic/core';

export function formatJson(result: WorkspaceAnalysisResult): string {
  return JSON.stringify(result, null, 2);
}
