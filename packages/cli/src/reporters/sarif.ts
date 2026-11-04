import type { WorkspaceAnalysisResult } from '@deontic/core';

export function formatSarif(result: WorkspaceAnalysisResult): string {
  return JSON.stringify({
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Sarif-2.1.0/coschema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'deontic',
            version: '0.1.0',
            rules: [],
          },
        },
        results: result.diagnostics,
      },
    ],
  }, null, 2);
}
