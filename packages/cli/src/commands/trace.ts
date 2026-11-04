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
  return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
}
