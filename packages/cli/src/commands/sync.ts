import { syncWorkspace } from '@deontic/core';

export interface SyncCommandOptions {
  cwd: string;
  from?: 'claude' | 'cursor';
  write?: boolean;
  check?: boolean;
  format?: 'pretty' | 'json';
}

export async function runSyncCommand(options: SyncCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await syncWorkspace(options);
  const exitCode = options.check && !result.inSync ? 1 : 0;
  return { exitCode, stdout: JSON.stringify(result, null, 2), stderr: '' };
}
