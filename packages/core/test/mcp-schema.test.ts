import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeWorkspace,
  detectParameterCasingCollisions,
  probeMcpServers,
  profileWorkspaceCost,
} from '../src/index.js';
import { runCli } from '../../cli/src/index.js';

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deontic-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('Ticket #7: MCP Schema Overload, Parameter Casing Collisions & Live Probe (CTX007)', () => {
  it('resolves known MCP servers via 0ms static Fingerprint Registry and flags >40 tool overload + bloated tools + parameter casing collisions', async () => {
    const cwd = createTempWorkspace();

    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            github: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
            },
            linear: {
              command: 'npx',
              args: ['-y', '@linear/mcp'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const analysis = await analyzeWorkspace({ cwd });
    const ctx007 = analysis.diagnostics.filter((d) => d.code === 'CTX007');

    // 1. Over 40 tools (80 + 24 = 104 tools, 25,844 tokens)
    expect(ctx007.some((d) => d.message.includes('104 MCP tools') && d.message.includes('25844 Turn-0 tokens'))).toBe(
      true,
    );

    // 2. Bloated tool schema (assign_copilot_to_issue >= 800 tokens)
    expect(ctx007.some((d) => d.message.includes('assign_copilot_to_issue') && d.message.includes('810 Turn-0 tokens'))).toBe(
      true,
    );

    // 3. Cross-server Parameter Casing Collisions (repo_name vs repoName, workspace_id vs workspaceId, project_id vs projectId, user_id vs userId)
    expect(
      ctx007.some(
        (d) =>
          d.message.includes("MCP Parameter Casing Collision on 'reponame'") &&
          d.message.includes('repo_name') &&
          d.message.includes('repoName'),
      ),
    ).toBe(true);
    expect(
      ctx007.some(
        (d) =>
          d.message.includes("MCP Parameter Casing Collision on 'workspaceid'") &&
          d.message.includes('workspace_id') &&
          d.message.includes('workspaceId'),
      ),
    ).toBe(true);

    // Cost report includes MCP server breakdown and parameter collisions
    const cost = await profileWorkspaceCost({ cwd });
    const claudeProfile = cost.profiles['claude-code'];
    expect(claudeProfile.mcpToolCount).toBe(104);
    expect(claudeProfile.mcpTokens).toBe(25844);
    expect(claudeProfile.mcpCollisions.some((c) => c.canonicalKey === 'reponame')).toBe(true);
  });

  it('discovers MCP configs across .cursor/mcp.json, .vscode/mcp.json, and claude_desktop_config.json', async () => {
    const cwd = createTempWorkspace();
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.vscode'), { recursive: true });

    fs.writeFileSync(
      path.join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['@playwright/mcp'] },
        },
      }),
      'utf8',
    );

    fs.writeFileSync(
      path.join(cwd, '.vscode', 'mcp.json'),
      JSON.stringify({
        servers: {
          postgres: { command: 'npx', args: ['server-postgres'] },
        },
      }),
      'utf8',
    );

    fs.writeFileSync(
      path.join(cwd, 'claude_desktop_config.json'),
      JSON.stringify({
        mcpServers: {
          sentry: { command: 'npx', args: ['@sentry/mcp'] },
        },
      }),
      'utf8',
    );

    const cost = await profileWorkspaceCost({ cwd });
    expect(cost.profiles.cursor.mcpToolCount).toBe(22);
    expect(cost.profiles.copilot.mcpToolCount).toBe(6);
    expect(cost.profiles['claude-code'].mcpToolCount).toBe(18);
  });

  it('performs live stdio JSON-RPC tools/list handshake via probeMcpServers and deontic mcp-probe, with graceful fallback on failure', async () => {
    const cwd = createTempWorkspace();

    // Write a mock stdio MCP server script that responds to initialize and tools/list
    const mockServerScript = path.join(cwd, 'mock-mcp-server.mjs');
    fs.writeFileSync(
      mockServerScript,
      `import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'custom-live-server', version: '1.0.0' }
      }
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'fetch_account',
            description: 'Fetch an account record by account_id and workspace_id',
            inputSchema: {
              type: 'object',
              properties: {
                account_id: { type: 'string' },
                workspace_id: { type: 'string' }
              }
            }
          },
          {
            name: 'update_account',
            description: 'Update an account record by accountId and workspaceId',
            inputSchema: {
              type: 'object',
              properties: {
                accountId: { type: 'string' },
                workspaceId: { type: 'string' }
              }
            }
          }
        ]
      }
    }) + '\\n');
  }
});
`,
      'utf8',
    );

    const failingServerScript = path.join(cwd, 'failing-mcp-server.mjs');
    fs.writeFileSync(failingServerScript, `process.exit(1);\n`, 'utf8');

    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            customLive: {
              command: process.execPath,
              args: [mockServerScript],
            },
            brokenGithub: {
              command: process.execPath,
              args: [failingServerScript, '@modelcontextprotocol/server-github'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const probed = await probeMcpServers({ cwd, timeoutMs: 2000 });
    expect(probed).toHaveLength(2);

    const liveSrv = probed.find((s) => s.serverName === 'customLive')!;
    expect(liveSrv.source).toBe('live-probe');
    expect(liveSrv.toolCount).toBe(2);
    expect(liveSrv.tools.map((t) => t.name)).toEqual(['fetch_account', 'update_account']);

    const brokenSrv = probed.find((s) => s.serverName === 'brokenGithub')!;
    expect(brokenSrv.source).toBe('registry');
    expect(brokenSrv.toolCount).toBe(80);
    expect(brokenSrv.error).toContain('exited with code 1');

    const collisions = detectParameterCasingCollisions([liveSrv]);
    expect(collisions.map((c) => c.canonicalKey).sort()).toEqual(['accountid', 'workspaceid']);

    // Verify CLI `deontic mcp-probe --format json` and `deontic cost --probe`
    const cliProbeRes = await runCli(['mcp-probe', '--format', 'json'], { cwd });
    expect(cliProbeRes.exitCode).toBe(0);
    const parsedProbe = JSON.parse(cliProbeRes.stdout);
    expect(parsedProbe.servers).toHaveLength(2);
    expect(parsedProbe.collisions.length).toBeGreaterThanOrEqual(2);

    const cliCostRes = await runCli(['cost', '--probe'], { cwd });
    expect(cliCostRes.exitCode).toBe(0);
    expect(cliCostRes.stdout).toContain('customLive (.mcp.json): 2 tools');
    expect(cliCostRes.stdout).toContain('[live-probe]');
  });
});
