import type { Diagnostic, McpServerProfile, WorkspaceContext } from '../types.js';

export function runMcpSchemaPass(_ctx: WorkspaceContext): Diagnostic[] {
  return [];
}

export async function probeMcpServers(_options: { cwd: string; timeoutMs?: number }): Promise<McpServerProfile[]> {
  return [];
}
