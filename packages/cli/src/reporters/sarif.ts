import type { DiagnosticCode, WorkspaceAnalysisResult } from '@deontic/core';

const SARIF_RULE_METADATA: Record<
  DiagnosticCode,
  { name: string; shortDescription: string; fullDescription: string; defaultLevel: 'error' | 'warning' }
> = {
  CTX001: {
    name: 'LogicalContradiction',
    shortDescription: 'Logical Contradiction across overlapping Effective Scopes',
    fullDescription:
      'Two Directives assert opposite polarities or mutually exclusive targets on the same canonical topic within an overlapping Effective Scope.',
    defaultLevel: 'error',
  },
  CTX002: {
    name: 'ContextBloatAndCliff',
    shortDescription: 'Context Bloat, >150 Directive Adherence Cliff, or Derivable Directory Tree',
    fullDescription:
      'Warns when an Agent Profile exceeds the 150-Directive adherence cliff, exceeds the 32 KiB file cap, or embeds a static Derivable Directory Tree.',
    defaultLevel: 'warning',
  },
  CTX003: {
    name: 'UnacknowledgedAncestorOverride',
    shortDescription: 'Unacknowledged Child vs. Ancestor Override',
    fullDescription:
      'A scoped or subdirectory Harness File reverses a root Directive without an explicit exclusion clause in the root file or a <!-- deontic-override --> pragma.',
    defaultLevel: 'warning',
  },
  CTX004: {
    name: 'DeadFileOrDirectoryReference',
    shortDescription: 'Dead File or Directory Reference',
    fullDescription:
      'A Directive or Context Note references a repository file or directory path that does not exist on disk.',
    defaultLevel: 'error',
  },
  CTX005: {
    name: 'NonExistentCommandOrManifestDrift',
    shortDescription: 'Non-Existent Script Command or Manifest Drift',
    fullDescription:
      'A Directive or Context Note references a build/test script command that does not exist in package.json, Makefile, Justfile, or Cargo.toml.',
    defaultLevel: 'error',
  },
  CTX006: {
    name: 'BrokenOrCircularImport',
    shortDescription: 'Broken, Circular, or Excessively Deep @path/to/file Import',
    fullDescription:
      'An @path/to/file import in a Harness File points to a missing file, creates a circular reference, or exceeds the maximum 5-hop depth.',
    defaultLevel: 'error',
  },
  CTX007: {
    name: 'McpSchemaOverloadOrCollision',
    shortDescription: 'MCP Schema Overload or Parameter Casing Collision',
    fullDescription:
      'Active MCP tools exceed the 40-tool accuracy threshold, a single tool schema exceeds 800 tokens, or active servers have conflicting parameter casing.',
    defaultLevel: 'warning',
  },
  CTX008: {
    name: 'DuplicateOrShadowedDirective',
    shortDescription: 'Duplicate or Shadowed Directive within the same Agent Profile',
    fullDescription:
      'Two Directives within the same Agent Profile have near-identical wording or identical canonical assertions across overlapping Effective Scopes.',
    defaultLevel: 'warning',
  },
  CTX009: {
    name: 'ZeroHitRootRuleSection',
    shortDescription: 'Zero-Hit Domain-Specific Rule Section in Root Harness File',
    fullDescription:
      'A domain-specific Rule Section in a root Harness File had a 0% session hit rate across local agent transcripts and should be extracted into a path-scoped rule.',
    defaultLevel: 'warning',
  },
};

export function formatSarif(result: WorkspaceAnalysisResult): string {
  const rules = (Object.keys(SARIF_RULE_METADATA) as DiagnosticCode[]).map((code) => {
    const meta = SARIF_RULE_METADATA[code];
    return {
      id: code,
      name: meta.name,
      shortDescription: { text: meta.shortDescription },
      fullDescription: { text: meta.fullDescription },
      defaultConfiguration: { level: meta.defaultLevel },
    };
  });

  const sarifResults = result.diagnostics.map((d) => {
    const loc = d.primaryLocation;
    const relatedLocations = (d.secondaryLocations ?? []).map((sec, idx) => ({
      id: idx + 1,
      message: { text: sec.label ?? sec.snippet ?? 'Related location' },
      physicalLocation: {
        artifactLocation: { uri: sec.file },
        region: {
          startLine: Math.max(1, sec.lineStart),
          endLine: Math.max(1, sec.lineEnd),
          startColumn: Math.max(1, sec.columnStart),
          endColumn: Math.max(1, sec.columnEnd),
        },
      },
    }));

    return {
      ruleId: d.code,
      level: d.severity === 'error' ? 'error' : 'warning',
      message: {
        text: d.suggestion ? `${d.message} Suggestion: ${d.suggestion}` : d.message,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: loc.file },
            region: {
              startLine: Math.max(1, loc.lineStart),
              endLine: Math.max(1, loc.lineEnd),
              startColumn: Math.max(1, loc.columnStart),
              endColumn: Math.max(1, loc.columnEnd),
            },
          },
        },
      ],
      ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
    };
  });

  return JSON.stringify(
    {
      $schema:
        'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Sarif-2.1.0/coschema/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'deontic',
              version: '0.1.0',
              informationUri: 'https://github.com/thilak15/deontic',
              rules,
            },
          },
          results: sarifResults,
          properties: {
            summary: result.summary,
            excludedCheckouts: result.excludedCheckouts,
          },
        },
      ],
    },
    null,
    2,
  );
}
