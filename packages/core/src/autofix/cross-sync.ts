import type { SyncWorkspaceOptions, SyncWorkspaceResult } from '../types.js';

export async function syncWorkspace(options: SyncWorkspaceOptions): Promise<SyncWorkspaceResult> {
  return {
    cwd: options.cwd,
    from: options.from ?? 'claude',
    written: false,
    inSync: true,
    targets: [],
  };
}
