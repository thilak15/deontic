import { analyzeWorkspace, type AgentProfileId } from '@deontic/core';
import { formatPretty } from '../reporters/pretty.js';
import { formatJson } from '../reporters/json.js';
import { formatSarif } from '../reporters/sarif.js';
import { formatGithub } from '../reporters/github.js';

export interface CheckCommandOptions {
  cwd: string;
  format?: 'pretty' | 'json' | 'sarif' | 'github';
  agent?: AgentProfileId;
  strict?: boolean;
  fix?: boolean;
  verbose?: boolean;
  probe?: boolean;
  traceDir?: string;
}

export async function runCheckCommand(options: CheckCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  let result = await analyzeWorkspace({
    cwd: options.cwd,
    agent: options.agent,
    strict: options.strict,
    fix: options.fix,
    probe: options.probe,
    traceDir: options.traceDir,
  });

  // If fixes were applied on disk, re-run analysis so reported diagnostics reflect post-fix state
  if (options.fix && result.appliedFixes.length > 0) {
    const applied = result.appliedFixes;
    result = await analyzeWorkspace({
      cwd: options.cwd,
      agent: options.agent,
      strict: options.strict,
      fix: false,
      probe: options.probe,
      traceDir: options.traceDir,
    });
    result = {
      ...result,
      appliedFixes: applied,
    };
  }

  const format = options.format ?? 'pretty';
  let stdout: string;
  switch (format) {
    case 'json':
      stdout = formatJson(result);
      break;
    case 'sarif':
      stdout = formatSarif(result);
      break;
    case 'github':
      stdout = formatGithub(result);
      break;
    case 'pretty':
    default:
      stdout = formatPretty(result, { verbose: options.verbose });
      break;
  }

  const hasErrors = result.diagnostics.some((d) => d.severity === 'error');
  const hasWarnings = result.diagnostics.some((d) => d.severity === 'warning');
  const exitCode = hasErrors || (Boolean(options.strict) && hasWarnings) ? 1 : 0;

  return {
    exitCode,
    stdout,
    stderr: '',
  };
}
