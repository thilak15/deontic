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
  const result = await syncWorkspace({
    cwd: options.cwd,
    from: options.from,
    write: options.write,
    check: options.check,
  });

  const exitCode = options.check && !result.inSync ? 1 : 0;

  if (options.format === 'json') {
    return {
      exitCode,
      stdout: JSON.stringify(result, null, 2),
      stderr: '',
    };
  }

  const lines: string[] = [];
  lines.push(`=== Deontic Cross-Tool Rule Sync (from: ${result.from}) ===`);
  if (result.targets.length === 0) {
    lines.push('No canonical rule sources found to synchronize.');
  } else {
    for (const target of result.targets) {
      const status = result.written
        ? 'WRITTEN'
        : target.drifted
          ? 'DRIFTED'
          : 'IN_SYNC';
      lines.push(`  [${status}] ${target.path}`);
    }
  }
  lines.push(
    result.inSync
      ? 'Status: All target Harness Files are in sync.'
      : 'Status: Drift detected between canonical source and target Harness Files.',
  );

  return {
    exitCode,
    stdout: lines.join('\n'),
    stderr: '',
  };
}
