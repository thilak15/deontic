import { detectParameterCasingCollisions, probeMcpServers } from '@deontic/core';

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
  const collisions = detectParameterCasingCollisions(servers);

  if (options.format === 'json') {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ servers, collisions }, null, 2),
      stderr: '',
    };
  }

  const lines: string[] = [];
  lines.push('=== Deontic Live MCP Server Probe ===');
  if (servers.length === 0) {
    lines.push('No MCP servers configured in workspace.');
  } else {
    for (const srv of servers) {
      const errTag = srv.error ? ` (fallback: ${srv.error})` : '';
      lines.push(
        `- ${srv.serverName} (${srv.sourceFile}): ${srv.toolCount} tools, ${srv.tokenCount} tokens [${srv.source}]${errTag}`,
      );
      for (const tool of srv.tools) {
        lines.push(
          `    * ${tool.name}(${tool.parameterNames.join(', ')}): ${tool.tokenCount} tokens`,
        );
      }
    }
  }

  if (collisions.length > 0) {
    lines.push('');
    lines.push(`Parameter Casing Collisions (${collisions.length}):`);
    for (const col of collisions) {
      const variants = col.parameters
        .map((p) => `${p.serverName}.${p.toolName}(${p.paramName})`)
        .join(' vs. ');
      lines.push(`  ! ${col.canonicalKey}: ${variants}`);
    }
  }

  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
