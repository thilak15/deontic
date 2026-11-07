import { loadWorkspaceConfig, profileWorkspaceCost, type AgentProfileId } from '@deontic/core';

export interface CostCommandOptions {
  cwd: string;
  format?: 'pretty' | 'json';
  probe?: boolean;
}

function renderBar(value: number, maxValue: number, width = 20): string {
  if (maxValue <= 0 || value <= 0) return '░'.repeat(width);
  const filled = Math.max(1, Math.min(width, Math.round((value / maxValue) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export async function runCostCommand(options: CostCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const config = loadWorkspaceConfig(options.cwd);
  const result = await profileWorkspaceCost({ cwd: options.cwd, probe: options.probe });

  if (options.format === 'json') {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push('=== Deontic Turn-0 Load & Context Budget Report ===');
  lines.push('');

  const profileOrder: AgentProfileId[] = ['claude-code', 'cursor', 'codex', 'copilot'];
  let activeProfileCount = 0;

  for (const profileId of profileOrder) {
    const budget = result.profiles[profileId];
    if (!budget || (budget.files.length === 0 && budget.mcpServers.length === 0)) {
      continue;
    }
    activeProfileCount++;

    const combinedTurn0Tokens = budget.turn0Tokens + budget.mcpTokens;
    const directiveWarning =
      budget.turn0Directives > config.maxDirectives
        ? ` [WARNING: Exceeds ${config.maxDirectives}-Directive adherence threshold]`
        : '';

    lines.push(`Agent Profile: ${profileId}`);
    lines.push(
      `  Turn-0 Load: ${combinedTurn0Tokens} tokens (${budget.turn0Bytes} bytes, ${budget.turn0Directives}/${config.maxDirectives} imperative Directives)${directiveWarning}`,
    );
    lines.push(
      `  Total Repo Scope: ${budget.totalTokens + budget.mcpTokens} tokens (${budget.totalDirectives} Directives across ${budget.files.length} Harness Files)`,
    );
    if (budget.wastedTreeTokens > 0) {
      lines.push(
        `  Derivable Directory Tree Waste: ${budget.wastedTreeTokens} tokens`,
      );
    }
    if (budget.mcpServers.length > 0 || budget.mcpToolCount > 0) {
      lines.push(
        `  MCP Schema Load: ${budget.mcpTokens} tokens across ${budget.mcpToolCount} tools (${budget.mcpServers.length} servers)`,
      );
      for (const srv of budget.mcpServers) {
        lines.push(
          `    - ${srv.serverName} (${srv.sourceFile}): ${srv.toolCount} tools, ${srv.tokenCount} tokens [${srv.source}]`,
        );
      }
      for (const col of budget.mcpCollisions) {
        const variants = col.parameters
          .map((p) => `${p.serverName}.${p.toolName}(${p.paramName})`)
          .join(' vs. ');
        lines.push(`    ! Parameter Casing Collision (${col.canonicalKey}): ${variants}`);
      }
    }

    if (budget.files.length > 0) {
      lines.push('  Files Breakdown:');
      const maxFileTokens = Math.max(1, ...budget.files.map((f) => f.tokenCount));
      for (const f of budget.files) {
        const bar = renderBar(f.tokenCount, maxFileTokens, 16);
        const scopeTag = f.isAlwaysLoadedAtRoot ? 'Turn-0' : 'Scoped';
        const treeTag = f.wastedTreeTokens > 0 ? `, ${f.wastedTreeTokens} tree-waste tokens` : '';
        lines.push(
          `    [${bar}] ${f.path} (${scopeTag}): ${f.tokenCount} tokens, ${f.directiveCount} Directives${treeTag}`,
        );
      }
    }
    lines.push('');
  }

  if (activeProfileCount === 0) {
    lines.push('No Harness Files detected in workspace.');
  }

  if (result.diagnostics.length > 0) {
    lines.push(`Diagnostics (${result.diagnostics.length}):`);
    for (const d of result.diagnostics) {
      lines.push(`  [${d.severity.toUpperCase()} ${d.code}] ${d.message}`);
    }
  }

  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
