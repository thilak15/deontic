import type { SplitWorkspaceOptions, SplitWorkspaceResult } from '../types.js';

export async function splitWorkspace(options: SplitWorkspaceOptions): Promise<SplitWorkspaceResult> {
  return {
    cwd: options.cwd,
    target: options.target ?? 'claude',
    written: false,
    proposedFiles: [],
    updatedRootFiles: [],
    turn0TokensBefore: 0,
    turn0TokensAfter: 0,
    reductionPercent: 0,
  };
}
