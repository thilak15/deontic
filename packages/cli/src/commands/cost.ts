import { profileWorkspaceCost } from '@deontic/core';

export interface CostCommandOptions {
  cwd: string;
  format?: 'pretty' | 'json';
  probe?: boolean;
}

export async function runCostCommand(options: CostCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await profileWorkspaceCost({ cwd: options.cwd, probe: options.probe });
  if (options.format === 'json') {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }
  return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
}
