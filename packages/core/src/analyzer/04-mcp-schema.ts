import { spawn } from 'node:child_process';
import type {
  AgentProfileId,
  Diagnostic,
  DiagnosticLocation,
  HarnessFile,
  McpServerProfile,
  McpToolParameterCollision,
  WorkspaceContext,
} from '../types.js';
import { loadWorkspaceConfig } from '../config/index.js';
import { discoverWorkspaceFiles } from '../discovery/index.js';
import { countTokens } from './03-bloat-cliff.js';

interface FingerprintEntry {
  matchRegex: RegExp;
  toolCount: number;
  tokenCount: number;
  sampleTools: Array<{
    name: string;
    tokenCount: number;
    parameterNames: string[];
  }>;
}

const MCP_FINGERPRINT_REGISTRY: FingerprintEntry[] = [
  {
    matchRegex: /@modelcontextprotocol\/server-github|\b(?:server-github|github-mcp-server|github)\b/i,
    toolCount: 80,
    tokenCount: 20444,
    sampleTools: [
      {
        name: 'get_issue',
        tokenCount: 280,
        parameterNames: ['owner', 'repo_name', 'issue_number', 'workspace_id'],
      },
      {
        name: 'create_issue',
        tokenCount: 340,
        parameterNames: ['owner', 'repo_name', 'title', 'body', 'project_id'],
      },
      {
        name: 'assign_copilot_to_issue',
        tokenCount: 810,
        parameterNames: ['owner', 'repo_name', 'issue_number', 'user_id'],
      },
    ],
  },
  {
    matchRegex: /@linear\/mcp|\b(?:linear-mcp|server-linear|linear)\b/i,
    toolCount: 24,
    tokenCount: 5400,
    sampleTools: [
      {
        name: 'get_issue',
        tokenCount: 240,
        parameterNames: ['issueId', 'repoName', 'workspaceId'],
      },
      {
        name: 'create_issue',
        tokenCount: 310,
        parameterNames: ['teamId', 'projectId', 'title', 'userId'],
      },
    ],
  },
  {
    matchRegex: /@playwright\/mcp|\b(?:server-playwright|playwright)\b/i,
    toolCount: 22,
    tokenCount: 4800,
    sampleTools: [
      {
        name: 'browser_navigate',
        tokenCount: 190,
        parameterNames: ['url'],
      },
      {
        name: 'browser_click',
        tokenCount: 220,
        parameterNames: ['element', 'ref'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-postgres|postgres-mcp|postgres(?:ql)?)\b/i,
    toolCount: 6,
    tokenCount: 1450,
    sampleTools: [
      {
        name: 'query',
        tokenCount: 210,
        parameterNames: ['sql', 'database_url'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-filesystem|filesystem-mcp|filesystem)\b/i,
    toolCount: 14,
    tokenCount: 3100,
    sampleTools: [
      {
        name: 'read_file',
        tokenCount: 180,
        parameterNames: ['file_path'],
      },
      {
        name: 'write_file',
        tokenCount: 200,
        parameterNames: ['file_path', 'content'],
      },
    ],
  },
  {
    matchRegex: /@sentry\/mcp|\b(?:server-sentry|sentry)\b/i,
    toolCount: 18,
    tokenCount: 4100,
    sampleTools: [
      {
        name: 'get_sentry_issue',
        tokenCount: 260,
        parameterNames: ['issue_id', 'project_id', 'organization_slug'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-slack|slack-mcp|slack)\b/i,
    toolCount: 12,
    tokenCount: 2750,
    sampleTools: [
      {
        name: 'post_message',
        tokenCount: 210,
        parameterNames: ['channel_id', 'user_id', 'text'],
      },
    ],
  },
  {
    matchRegex: /@supabase\/mcp|\b(?:supabase-mcp|supabase)\b/i,
    toolCount: 25,
    tokenCount: 6200,
    sampleTools: [
      {
        name: 'execute_sql',
        tokenCount: 240,
        parameterNames: ['project_id', 'query'],
      },
    ],
  },
  {
    matchRegex: /@stripe\/mcp|\b(?:stripe-mcp|stripe)\b/i,
    toolCount: 28,
    tokenCount: 6800,
    sampleTools: [
      {
        name: 'create_customer',
        tokenCount: 230,
        parameterNames: ['email', 'user_id'],
      },
    ],
  },
  {
    matchRegex: /@notionhq\/notion-mcp-server|\b(?:notion-mcp|notion)\b/i,
    toolCount: 19,
    tokenCount: 4600,
    sampleTools: [
      {
        name: 'retrieve_page',
        tokenCount: 220,
        parameterNames: ['pageId', 'workspaceId'],
      },
    ],
  },
  {
    matchRegex: /\b(?:atlassian|jira-mcp|jira)\b/i,
    toolCount: 32,
    tokenCount: 7900,
    sampleTools: [
      {
        name: 'get_jira_issue',
        tokenCount: 290,
        parameterNames: ['issueKey', 'projectId', 'workspaceId'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-puppeteer|puppeteer)\b/i,
    toolCount: 10,
    tokenCount: 2200,
    sampleTools: [
      {
        name: 'puppeteer_navigate',
        tokenCount: 180,
        parameterNames: ['url'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-brave-search|brave-search)\b/i,
    toolCount: 4,
    tokenCount: 950,
    sampleTools: [
      {
        name: 'brave_web_search',
        tokenCount: 240,
        parameterNames: ['query', 'count'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-memory|memory)\b/i,
    toolCount: 9,
    tokenCount: 2050,
    sampleTools: [
      {
        name: 'create_entities',
        tokenCount: 220,
        parameterNames: ['entities'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-fetch|fetch)\b/i,
    toolCount: 2,
    tokenCount: 520,
    sampleTools: [
      {
        name: 'fetch',
        tokenCount: 260,
        parameterNames: ['url', 'max_length'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-git|git)\b/i,
    toolCount: 12,
    tokenCount: 2650,
    sampleTools: [
      {
        name: 'git_status',
        tokenCount: 180,
        parameterNames: ['repo_path'],
      },
    ],
  },
  {
    matchRegex: /\b(?:server-sqlite|sqlite)\b/i,
    toolCount: 8,
    tokenCount: 1800,
    sampleTools: [
      {
        name: 'read_query',
        tokenCount: 200,
        parameterNames: ['query'],
      },
    ],
  },
];

export interface RawConfiguredMcpServer {
  serverName: string;
  sourceFile: string;
  agentProfiles: AgentProfileId[];
  command: string;
  args: string[];
  env: Record<string, string>;
  inlineTools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    parameterNames?: string[];
    tokenCount?: number;
  }>;
  lineStart: number;
}

function findServerLineInJson(rawContent: string, serverName: string): number {
  const lines = rawContent.split(/\r?\n/);
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"${escaped}"\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}

export function extractConfiguredMcpServers(harnessFiles: HarnessFile[]): RawConfiguredMcpServer[] {
  const servers: RawConfiguredMcpServer[] = [];

  for (const hf of harnessFiles) {
    if (hf.format !== 'mcp-config') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(hf.rawContent) as Record<string, unknown>;
    } catch {
      continue;
    }

    const container =
      (parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? (parsed.mcpServers as Record<string, unknown>)
        : parsed.servers && typeof parsed.servers === 'object'
          ? (parsed.servers as Record<string, unknown>)
          : null);
    if (!container) continue;

    for (const [serverName, rawDef] of Object.entries(container)) {
      if (!rawDef || typeof rawDef !== 'object') continue;
      const def = rawDef as Record<string, unknown>;
      const command = typeof def.command === 'string' ? def.command : '';
      const args = Array.isArray(def.args)
        ? def.args.filter((a): a is string => typeof a === 'string')
        : [];
      const env: Record<string, string> = {};
      if (def.env && typeof def.env === 'object') {
        for (const [k, v] of Object.entries(def.env as Record<string, unknown>)) {
          if (typeof v === 'string') env[k] = v;
        }
      }

      let inlineTools: RawConfiguredMcpServer['inlineTools'];
      if (Array.isArray(def.tools)) {
        inlineTools = [];
        for (const t of def.tools) {
          if (t && typeof t === 'object') {
            const tObj = t as Record<string, unknown>;
            const name = typeof tObj.name === 'string' ? tObj.name : 'tool';
            const description = typeof tObj.description === 'string' ? tObj.description : undefined;
            const inputSchema =
              tObj.inputSchema && typeof tObj.inputSchema === 'object'
                ? (tObj.inputSchema as Record<string, unknown>)
                : undefined;
            const parameterNames = Array.isArray(tObj.parameterNames)
              ? tObj.parameterNames.filter((p): p is string => typeof p === 'string')
              : inputSchema &&
                  typeof inputSchema.properties === 'object' &&
                  inputSchema.properties !== null
                ? Object.keys(inputSchema.properties as Record<string, unknown>)
                : [];
            const tokenCount =
              typeof tObj.tokenCount === 'number'
                ? tObj.tokenCount
                : countTokens(JSON.stringify(tObj));
            inlineTools.push({
              name,
              description,
              inputSchema,
              parameterNames,
              tokenCount,
            });
          }
        }
      }

      servers.push({
        serverName,
        sourceFile: hf.path,
        agentProfiles: hf.agentProfiles,
        command,
        args,
        env,
        inlineTools,
        lineStart: findServerLineInJson(hf.rawContent, serverName),
      });
    }
  }

  return servers;
}

export function profileServerStatically(raw: RawConfiguredMcpServer): McpServerProfile {
  if (raw.inlineTools && raw.inlineTools.length > 0) {
    const tools = raw.inlineTools.map((t) => ({
      name: t.name,
      description: t.description,
      tokenCount: t.tokenCount ?? 200,
      parameterNames: t.parameterNames ?? [],
    }));
    const tokenCount = tools.reduce((sum, t) => sum + t.tokenCount, 0);
    return {
      serverName: raw.serverName,
      sourceFile: raw.sourceFile,
      command: raw.command,
      args: raw.args,
      toolCount: tools.length,
      tokenCount,
      source: 'registry',
      tools,
    };
  }

  const fingerprintHaystack = `${raw.serverName} ${raw.command} ${raw.args.join(' ')}`;
  for (const entry of MCP_FINGERPRINT_REGISTRY) {
    if (entry.matchRegex.test(fingerprintHaystack)) {
      return {
        serverName: raw.serverName,
        sourceFile: raw.sourceFile,
        command: raw.command,
        args: raw.args,
        toolCount: entry.toolCount,
        tokenCount: entry.tokenCount,
        source: 'registry',
        tools: entry.sampleTools.map((t) => ({
          name: t.name,
          tokenCount: t.tokenCount,
          parameterNames: [...t.parameterNames],
        })),
      };
    }
  }

  // Heuristic fallback for unknown servers
  return {
    serverName: raw.serverName,
    sourceFile: raw.sourceFile,
    command: raw.command,
    args: raw.args,
    toolCount: 8,
    tokenCount: 1600,
    source: 'heuristic',
    tools: [],
  };
}

export function classifyCasingStyle(
  paramName: string,
): 'snake_case' | 'camelCase' | 'kebab-case' | 'PascalCase' | 'other' {
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(paramName)) return 'snake_case';
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(paramName)) return 'camelCase';
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(paramName)) return 'kebab-case';
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(paramName)) return 'PascalCase';
  return 'other';
}

export function detectParameterCasingCollisions(
  servers: McpServerProfile[],
): McpToolParameterCollision[] {
  const byCanonicalKey = new Map<
    string,
    Array<{
      serverName: string;
      toolName: string;
      paramName: string;
      casingStyle: 'snake_case' | 'camelCase' | 'kebab-case' | 'PascalCase' | 'other';
    }>
  >();

  for (const srv of servers) {
    for (const tool of srv.tools) {
      for (const paramName of tool.parameterNames) {
        const canonicalKey = paramName.toLowerCase().replace(/[_-]+/g, '');
        if (canonicalKey.length < 4) continue;
        const casingStyle = classifyCasingStyle(paramName);
        if (casingStyle === 'other') continue;

        const list = byCanonicalKey.get(canonicalKey) ?? [];
        if (
          !list.some(
            (item) =>
              item.serverName === srv.serverName &&
              item.toolName === tool.name &&
              item.paramName === paramName,
          )
        ) {
          list.push({
            serverName: srv.serverName,
            toolName: tool.name,
            paramName,
            casingStyle,
          });
          byCanonicalKey.set(canonicalKey, list);
        }
      }
    }
  }

  const collisions: McpToolParameterCollision[] = [];
  for (const [canonicalKey, parameters] of byCanonicalKey.entries()) {
    const styles = new Set(parameters.map((p) => p.casingStyle));
    const names = new Set(parameters.map((p) => p.paramName));
    if (styles.size > 1 && names.size > 1) {
      collisions.push({
        canonicalKey,
        parameters,
      });
    }
  }

  return collisions;
}

async function probeSingleStdioServer(
  raw: RawConfiguredMcpServer,
  cwd: string,
  timeoutMs: number,
): Promise<McpServerProfile> {
  if (!raw.command) {
    return {
      ...profileServerStatically(raw),
      error: 'Missing command in MCP server config',
    };
  }

  return new Promise<McpServerProfile>((resolve) => {
    let settled = false;
    const finish = (profile: McpServerProfile) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(profile);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(raw.command, raw.args, {
        cwd,
        env: { ...process.env, ...raw.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const fallback = profileServerStatically(raw);
      resolve({
        ...fallback,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      const fallback = profileServerStatically(raw);
      finish({
        ...fallback,
        error: `MCP stdio handshake timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    let stdoutBuffer = '';
    let sentToolsList = false;

    const sendJsonRpc = (msg: Record<string, unknown>) => {
      try {
        child.stdin?.write(JSON.stringify(msg) + '\n');
      } catch {
        // ignore write errors
      }
    };

    const handleJsonMessage = (msg: Record<string, unknown>) => {
      if (msg.id === 1 && !sentToolsList) {
        sentToolsList = true;
        sendJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        sendJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        return;
      }

      if (msg.id === 2 && msg.result && typeof msg.result === 'object') {
        const resObj = msg.result as Record<string, unknown>;
        const rawTools = Array.isArray(resObj.tools) ? resObj.tools : [];
        const tools: McpServerProfile['tools'] = [];

        for (const t of rawTools) {
          if (!t || typeof t !== 'object') continue;
          const tObj = t as Record<string, unknown>;
          const name = typeof tObj.name === 'string' ? tObj.name : 'tool';
          const description = typeof tObj.description === 'string' ? tObj.description : undefined;
          const schema =
            tObj.inputSchema && typeof tObj.inputSchema === 'object'
              ? (tObj.inputSchema as Record<string, unknown>)
              : undefined;
          const parameterNames =
            schema && typeof schema.properties === 'object' && schema.properties !== null
              ? Object.keys(schema.properties as Record<string, unknown>)
              : [];
          const tokenCount = countTokens(JSON.stringify(tObj));
          tools.push({
            name,
            description,
            tokenCount,
            parameterNames,
          });
        }

        const totalTokens = tools.reduce((sum, t) => sum + t.tokenCount, 0);
        finish({
          serverName: raw.serverName,
          sourceFile: raw.sourceFile,
          command: raw.command,
          args: raw.args,
          toolCount: tools.length,
          tokenCount: totalTokens,
          source: 'live-probe',
          tools,
        });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          handleJsonMessage(parsed);
        } catch {
          // ignore partial/non-JSON lines
        }
      }
    });

    child.on('error', (err) => {
      const fallback = profileServerStatically(raw);
      finish({
        ...fallback,
        error: err.message,
      });
    });

    child.on('exit', (code) => {
      if (!settled) {
        const fallback = profileServerStatically(raw);
        finish({
          ...fallback,
          error: `MCP server exited with code ${code ?? 'unknown'} before returning tools/list`,
        });
      }
    });

    // Send initialize request immediately, and also schedule tools/list if server accepts direct requests
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'deontic-mcp-probe', version: '0.1.0' },
      },
    });
  });
}

export async function probeMcpServers(options: {
  cwd: string;
  timeoutMs?: number;
}): Promise<McpServerProfile[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const config = loadWorkspaceConfig(options.cwd);
  const discovered = discoverWorkspaceFiles(options.cwd, config);
  const rawServers = extractConfiguredMcpServers(discovered.harnessFiles);

  const results: McpServerProfile[] = [];
  for (const raw of rawServers) {
    const profile = await probeSingleStdioServer(raw, options.cwd, timeoutMs);
    results.push(profile);
  }
  return results;
}

export function evaluateMcpForWorkspace(
  ctx: WorkspaceContext,
  liveProfiles?: McpServerProfile[],
): {
  serversByProfile: Record<AgentProfileId, McpServerProfile[]>;
  collisionsByProfile: Record<AgentProfileId, McpToolParameterCollision[]>;
  diagnostics: Diagnostic[];
} {
  const rawServers = extractConfiguredMcpServers(ctx.harnessFiles);
  const liveMap = new Map<string, McpServerProfile>();
  if (liveProfiles) {
    for (const lp of liveProfiles) {
      liveMap.set(`${lp.sourceFile}::${lp.serverName}`, lp);
    }
  }

  const resolvedServers: Array<{
    raw: RawConfiguredMcpServer;
    profile: McpServerProfile;
  }> = rawServers.map((raw) => ({
    raw,
    profile: liveMap.get(`${raw.sourceFile}::${raw.serverName}`) ?? profileServerStatically(raw),
  }));

  const profilesList: AgentProfileId[] = ['claude-code', 'cursor', 'codex', 'copilot'];
  const serversByProfile: Record<AgentProfileId, McpServerProfile[]> = {
    'claude-code': [],
    cursor: [],
    codex: [],
    copilot: [],
  };
  const collisionsByProfile: Record<AgentProfileId, McpToolParameterCollision[]> = {
    'claude-code': [],
    cursor: [],
    codex: [],
    copilot: [],
  };

  for (const item of resolvedServers) {
    for (const p of item.raw.agentProfiles) {
      serversByProfile[p].push(item.profile);
    }
  }

  for (const p of profilesList) {
    collisionsByProfile[p] = detectParameterCasingCollisions(serversByProfile[p]);
  }

  const diagnostics: Diagnostic[] = [];
  const maxMcpTools = ctx.config.maxMcpTools;

  // 1. Check total active MCP tools per Agent Profile against maxMcpTools (default 40)
  // Deduplicate identical MCP file tool-limit warnings across shared profiles
  const reportedToolLimitFiles = new Set<string>();
  for (const p of profilesList) {
    const srvs = serversByProfile[p];
    if (srvs.length === 0) continue;

    const totalTools = srvs.reduce((sum, s) => sum + s.toolCount, 0);
    const totalTokens = srvs.reduce((sum, s) => sum + s.tokenCount, 0);

    if (totalTools > maxMcpTools) {
      const primarySrv = [...srvs].sort((a, b) => b.toolCount - a.toolCount)[0];
      const dedupKey = `${primarySrv.sourceFile}:${totalTools}`;
      if (reportedToolLimitFiles.has(dedupKey)) continue;
      reportedToolLimitFiles.add(dedupKey);

      const rawMeta = rawServers.find(
        (r) => r.sourceFile === primarySrv.sourceFile && r.serverName === primarySrv.serverName,
      );
      const lineStart = rawMeta?.lineStart ?? 1;

      diagnostics.push({
        code: 'CTX007',
        severity: 'warning',
        agentProfile: p,
        message: `MCP Schema Overload: Agent Profile '${p}' loads ${totalTools} MCP tools (${totalTokens} Turn-0 tokens), exceeding the ${maxMcpTools}-tool accuracy threshold.`,
        primaryLocation: {
          file: primarySrv.sourceFile,
          lineStart,
          lineEnd: lineStart,
          columnStart: 1,
          columnEnd: 20,
          label: `${primarySrv.serverName} injects ${primarySrv.toolCount} tools (${primarySrv.tokenCount} tokens)`,
        },
        suggestion: `Disable unused MCP servers or restrict enabled tools so active tool count stays <= ${maxMcpTools}.`,
        help: `Tool-call selection accuracy degrades sharply past ~${maxMcpTools} active MCP tools.`,
      });
    }
  }

  // 2. Check individual bloated tools (>800 tokens)
  for (const { raw, profile } of resolvedServers) {
    for (const tool of profile.tools) {
      if (tool.tokenCount >= 800) {
        diagnostics.push({
          code: 'CTX007',
          severity: 'warning',
          agentProfile: raw.agentProfiles[0],
          message: `Bloated MCP Tool Schema: '${profile.serverName}.${tool.name}' consumes ${tool.tokenCount} Turn-0 tokens by itself.`,
          primaryLocation: {
            file: raw.sourceFile,
            lineStart: raw.lineStart,
            lineEnd: raw.lineStart,
            columnStart: 1,
            columnEnd: 20,
            label: `${tool.name} (${tool.tokenCount} tokens)`,
          },
          suggestion: `Filter or trim the '${tool.name}' schema on server '${profile.serverName}'.`,
        });
      }
    }
  }

  // 3. Check Parameter Casing Collisions across active servers
  const reportedCollisionKeys = new Set<string>();
  for (const p of profilesList) {
    for (const col of collisionsByProfile[p]) {
      const variants = col.parameters
        .map((param) => `${param.serverName}.${param.toolName}(${param.paramName})`)
        .join(' vs. ');
      const dedupKey = `${col.canonicalKey}::${variants}`;
      if (reportedCollisionKeys.has(dedupKey)) continue;
      reportedCollisionKeys.add(dedupKey);

      const firstParam = col.parameters[0];
      const rawMeta = rawServers.find((r) => r.serverName === firstParam.serverName);
      const sourceFile = rawMeta?.sourceFile ?? 'mcp.json';
      const lineStart = rawMeta?.lineStart ?? 1;

      const secondaryLocations: DiagnosticLocation[] = col.parameters.slice(1).map((param) => {
        const meta = rawServers.find((r) => r.serverName === param.serverName);
        const ln = meta?.lineStart ?? 1;
        return {
          file: meta?.sourceFile ?? sourceFile,
          lineStart: ln,
          lineEnd: ln,
          columnStart: 1,
          columnEnd: 20,
          label: `${param.serverName}.${param.toolName} uses ${param.casingStyle} '${param.paramName}'`,
        };
      });

      diagnostics.push({
        code: 'CTX007',
        severity: 'warning',
        agentProfile: p,
        message: `MCP Parameter Casing Collision on '${col.canonicalKey}': ${variants}`,
        primaryLocation: {
          file: sourceFile,
          lineStart,
          lineEnd: lineStart,
          columnStart: 1,
          columnEnd: 20,
          label: `${firstParam.serverName}.${firstParam.toolName} uses ${firstParam.casingStyle} '${firstParam.paramName}'`,
        },
        secondaryLocations: secondaryLocations.length > 0 ? secondaryLocations : undefined,
        suggestion: `Standardize parameter casing across MCP tools or scope conflicting MCP servers to separate Agent Profiles.`,
        help: `Conflicting parameter casing (snake_case vs. camelCase) for the same concept increases LLM tool-call argument errors.`,
      });
    }
  }

  return {
    serversByProfile,
    collisionsByProfile,
    diagnostics,
  };
}

export function runMcpSchemaPass(
  ctx: WorkspaceContext,
  liveProfiles?: McpServerProfile[],
): Diagnostic[] {
  return evaluateMcpForWorkspace(ctx, liveProfiles).diagnostics;
}
