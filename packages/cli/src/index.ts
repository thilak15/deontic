import type { AgentProfileId } from '@deontic/core';
import { runCheckCommand } from './commands/check.js';
import { runCostCommand } from './commands/cost.js';
import { runTraceCommand } from './commands/trace.js';
import { runSplitCommand } from './commands/split.js';
import { runSyncCommand } from './commands/sync.js';
import { runMcpProbeCommand } from './commands/mcp-probe.js';

export interface CliRunOptions {
  cwd?: string;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[], options: CliRunOptions = {}): Promise<CliRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const args = [...argv];

  let subcommand = 'check';
  if (args.length > 0 && !args[0].startsWith('-')) {
    subcommand = args.shift()!;
  }

  const getFlagValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) {
      return eq.slice(flag.length + 1);
    }
    return undefined;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  const format = (getFlagValue('--format') ?? 'pretty') as 'pretty' | 'json' | 'sarif' | 'github';
  const agent = getFlagValue('--agent') as AgentProfileId | undefined;
  const strict = hasFlag('--strict');
  const fix = hasFlag('--fix');
  const write = hasFlag('--write');
  const check = hasFlag('--check');
  const probe = hasFlag('--probe');
  const traceDir = getFlagValue('--trace-dir');
  const target = getFlagValue('--target') as 'claude' | 'cursor' | undefined;
  const from = getFlagValue('--from') as 'claude' | 'cursor' | undefined;

  switch (subcommand) {
    case 'check':
      return runCheckCommand({ cwd, format, agent, strict, fix, probe, traceDir });
    case 'cost':
      return runCostCommand({ cwd, format: format === 'json' ? 'json' : 'pretty', probe });
    case 'trace':
      return runTraceCommand({ cwd, traceDir, format: format === 'json' ? 'json' : 'pretty' });
    case 'split':
      return runSplitCommand({ cwd, target, write, fix, format: format === 'json' ? 'json' : 'pretty' });
    case 'sync':
      return runSyncCommand({ cwd, from, write, check, format: format === 'json' ? 'json' : 'pretty' });
    case 'mcp-probe':
      return runMcpProbeCommand({ cwd, format: format === 'json' ? 'json' : 'pretty' });
    default:
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Unknown command: ${subcommand}`,
      };
  }
}

export { formatPretty } from './reporters/pretty.js';
export { formatJson } from './reporters/json.js';
export { formatSarif } from './reporters/sarif.js';
export { formatGithub } from './reporters/github.js';
