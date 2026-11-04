import type { Diagnostic, TraceCorrelationResult, WorkspaceContext } from '../types.js';

export function runTraceRoiPass(_ctx: WorkspaceContext): Diagnostic[] {
  return [];
}

export async function correlateWorkspaceTraces(options: {
  cwd: string;
  traceDir?: string;
}): Promise<TraceCorrelationResult> {
  return {
    cwd: options.cwd,
    sessionsAnalyzed: 0,
    sections: [],
    diagnostics: [],
  };
}
