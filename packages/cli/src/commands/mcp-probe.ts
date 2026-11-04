import { probeMcpServers } from '@deontic/core';

export interface McpProbeCommandOptions {
  cwd: string;
  format?: 'pretty' | 'json';
  timeoutMs?: number;
}

export async function runMcpProbeCommand(options: McpProbeCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const servers = await probeMcpServers({ cwd: options.cwd, timeoutMs: options.timeoutMs });
  return { exitCode: 0, stdout: JSON.stringify(servers, null, 2), stderr: '' };
}
