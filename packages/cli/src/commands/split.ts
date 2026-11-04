import { splitWorkspace } from '@deontic/core';

export interface SplitCommandOptions {
  cwd: string;
  target?: 'claude' | 'cursor';
  write?: boolean;
  fix?: boolean;
  format?: 'pretty' | 'json';
}

export async function runSplitCommand(options: SplitCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await splitWorkspace(options);
  return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
}
