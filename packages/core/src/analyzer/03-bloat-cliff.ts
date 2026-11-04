import type { CostProfileResult, Diagnostic, WorkspaceContext } from '../types.js';

export function runBloatCliffPass(_ctx: WorkspaceContext): Diagnostic[] {
  return [];
}

export async function profileWorkspaceCost(options: { cwd: string; probe?: boolean }): Promise<CostProfileResult> {
  return {
    cwd: options.cwd,
    profiles: {
      'claude-code': {
        agentProfile: 'claude-code',
        turn0Tokens: 0,
        turn0Bytes: 0,
        turn0Directives: 0,
        totalTokens: 0,
        totalDirectives: 0,
        wastedTreeTokens: 0,
        mcpTokens: 0,
        mcpToolCount: 0,
        files: [],
        mcpServers: [],
        mcpCollisions: [],
      },
      cursor: {
        agentProfile: 'cursor',
        turn0Tokens: 0,
        turn0Bytes: 0,
        turn0Directives: 0,
        totalTokens: 0,
        totalDirectives: 0,
        wastedTreeTokens: 0,
        mcpTokens: 0,
        mcpToolCount: 0,
        files: [],
        mcpServers: [],
        mcpCollisions: [],
      },
      codex: {
        agentProfile: 'codex',
        turn0Tokens: 0,
        turn0Bytes: 0,
        turn0Directives: 0,
        totalTokens: 0,
        totalDirectives: 0,
        wastedTreeTokens: 0,
        mcpTokens: 0,
        mcpToolCount: 0,
        files: [],
        mcpServers: [],
        mcpCollisions: [],
      },
      copilot: {
        agentProfile: 'copilot',
        turn0Tokens: 0,
        turn0Bytes: 0,
        turn0Directives: 0,
        totalTokens: 0,
        totalDirectives: 0,
        wastedTreeTokens: 0,
        mcpTokens: 0,
        mcpToolCount: 0,
        files: [],
        mcpServers: [],
        mcpCollisions: [],
      },
    },
    diagnostics: [],
  };
}
