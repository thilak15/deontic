import { correlateWorkspaceTraces } from '@deontic/core';

export interface TraceCommandOptions {
  cwd: string;
  traceDir?: string;
  format?: 'pretty' | 'json';
}

export async function runTraceCommand(options: TraceCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await correlateWorkspaceTraces({ cwd: options.cwd, traceDir: options.traceDir });
  if (options.format === 'json') {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push('=== Deontic Session Trace ROI Report ===');
  lines.push(`Sessions analyzed: ${result.sessionsAnalyzed}`);
  lines.push('');

  for (const sec of result.sections) {
    const deadTag = sec.isDeadRuleSection ? ' [DEAD RULE SECTION - CTX009]' : '';
    const scopeTag = sec.isDomainSpecific ? `globs: ${sec.inferredGlobs.join(', ')}` : 'global';
    lines.push(
      `- ${sec.sourceFile} :: "${sec.heading}" (${scopeTag}) -> ${sec.sessionHitRate}% (${sec.sessionsHit}/${sec.sessionsAnalyzed} sessions, ${sec.tokenCount} tokens)${deadTag}`,
    );
  }

  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
