import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Diagnostic,
  RuleSection,
  SectionTraceRoi,
  TraceCorrelationResult,
  WorkspaceContext,
} from '../types.js';
import { loadWorkspaceConfig } from '../config/index.js';
import { discoverWorkspaceFiles } from '../discovery/index.js';
import { estimateTokenCount } from '../parser/index.js';
import { matchesGlobSet, toPosixPath } from '../scope/index.js';
import { inferSectionScope } from '../autofix/path-splitter.js';
import { filterAndMapDiagnostics } from './index.js';

interface ParsedSessionTrace {
  sessionFile: string;
  touchedPaths: Set<string>;
  executedCommands: Set<string>;
}

const FILE_TOOL_NAMES = new Set([
  'read',
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'glob',
  'grep',
  'read_file',
  'write_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'view_file',
]);

const BASH_TOOL_NAMES = new Set([
  'bash',
  'run_command',
  'shell',
  'terminal',
  'exec',
  'execute_command',
]);

function encodeCwdForClaudeProjects(cwd: string): string[] {
  const abs = path.resolve(cwd);
  const slashToDash = abs.split(path.sep).join('-');
  const nonAlnumToDash = abs.replace(/[^a-zA-Z0-9-]/g, '-');
  return Array.from(new Set([slashToDash, nonAlnumToDash]));
}

function resolveTraceDirectory(cwd: string, explicitTraceDir?: string): string | null {
  if (explicitTraceDir) {
    const resolved = path.isAbsolute(explicitTraceDir)
      ? explicitTraceDir
      : path.resolve(cwd, explicitTraceDir);
    return fs.existsSync(resolved) ? resolved : null;
  }

  const homeDir = process.env.HOME || os.homedir();
  if (!homeDir) return null;

  for (const encoded of encodeCwdForClaudeProjects(cwd)) {
    const candidate = path.join(homeDir, '.claude', 'projects', encoded);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function listJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function normalizeTouchedPath(rawPath: string, cwd: string): string | null {
  const trimmed = rawPath.trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!trimmed) return null;

  const absCwd = path.resolve(cwd);
  let rel = trimmed;
  if (path.isAbsolute(trimmed)) {
    const posixAbs = toPosixPath(trimmed);
    const posixCwd = toPosixPath(absCwd);
    if (posixAbs === posixCwd) return null;
    if (posixAbs.startsWith(`${posixCwd}/`)) {
      rel = posixAbs.slice(posixCwd.length + 1);
    } else {
      rel = posixAbs.replace(/^\/+/, '');
    }
  }

  const posix = toPosixPath(rel).replace(/^\.\//, '').replace(/\/+$/, '');
  return posix || null;
}

function extractFromObject(
  obj: unknown,
  cwd: string,
  touchedPaths: Set<string>,
  executedCommands: Set<string>,
  parentToolName?: string,
): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractFromObject(item, cwd, touchedPaths, executedCommands, parentToolName);
    }
    return;
  }

  const rec = obj as Record<string, unknown>;
  const rawName =
    typeof rec.name === 'string'
      ? rec.name
      : typeof rec.tool === 'string'
        ? rec.tool
        : typeof rec.tool_name === 'string'
          ? rec.tool_name
          : typeof rec.toolName === 'string'
            ? rec.toolName
            : parentToolName;
  const toolName = rawName ? rawName.toLowerCase() : undefined;

  // Check path-like properties
  const pathKeys = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'notebook_path'];
  for (const key of pathKeys) {
    const val = rec[key];
    if (typeof val === 'string') {
      const norm = normalizeTouchedPath(val, cwd);
      if (norm) touchedPaths.add(norm);
    }
  }

  // For Glob tool, `pattern` may also be a path or glob
  if ((toolName === 'glob' || toolName === 'grep') && typeof rec.pattern === 'string') {
    const pat = rec.pattern.trim();
    if (pat.includes('/') || pat.startsWith('*.') || /\.[a-zA-Z0-9]+$/.test(pat)) {
      const norm = normalizeTouchedPath(pat, cwd);
      if (norm) touchedPaths.add(norm);
    }
  }

  // Check command-like properties
  const cmdKeys = ['command', 'cmd', 'commandLine', 'CommandLine'];
  for (const key of cmdKeys) {
    const val = rec[key];
    if (typeof val === 'string' && (!toolName || BASH_TOOL_NAMES.has(toolName) || key === 'command')) {
      const cmd = val.trim();
      if (cmd) executedCommands.add(cmd);
    }
  }

  // Recurse into nested containers (message, content, input, arguments, tool_input, tool_calls, edits, function)
  const nestedKeys = [
    'message',
    'content',
    'input',
    'tool_input',
    'toolInput',
    'arguments',
    'args',
    'tool_calls',
    'toolCalls',
    'edits',
    'function',
    'data',
  ];
  for (const key of nestedKeys) {
    const val = rec[key];
    if (typeof val === 'string' && (key === 'arguments' || key === 'input')) {
      try {
        const parsed = JSON.parse(val);
        extractFromObject(parsed, cwd, touchedPaths, executedCommands, toolName);
      } catch {
        // ignore non-JSON string
      }
    } else if (val && typeof val === 'object') {
      extractFromObject(val, cwd, touchedPaths, executedCommands, toolName);
    }
  }

  // Also check if `FILE_TOOL_NAMES` has `files` array of strings
  if (toolName && FILE_TOOL_NAMES.has(toolName) && Array.isArray(rec.files)) {
    for (const f of rec.files) {
      if (typeof f === 'string') {
        const norm = normalizeTouchedPath(f, cwd);
        if (norm) touchedPaths.add(norm);
      }
    }
  }
}

function parseSessionJsonlFile(filePath: string, cwd: string): ParsedSessionTrace | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const touchedPaths = new Set<string>();
  const executedCommands = new Set<string>();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      extractFromObject(parsed, cwd, touchedPaths, executedCommands);
    } catch {
      // Ignore malformed JSONL lines
    }
  }

  return {
    sessionFile: filePath,
    touchedPaths,
    executedCommands,
  };
}

function doesSessionMatchSection(
  session: ParsedSessionTrace,
  section: RuleSection,
  inferredGlobs: string[],
): boolean {
  // 1. Check touched file paths against section's inferredGlobs & referencedPaths
  for (const touched of session.touchedPaths) {
    if (matchesGlobSet(touched, inferredGlobs)) {
      return true;
    }
    // If touched is a directory path (e.g. from Grep `path: "src/components"`), check probe child paths
    if (
      matchesGlobSet(`${touched}/index.ts`, inferredGlobs) ||
      matchesGlobSet(`${touched}/index.tsx`, inferredGlobs)
    ) {
      return true;
    }
    for (const g of inferredGlobs) {
      const prefix = g.replace(/\/\*\*.*$/, '').replace(/\/\*.*$/, '');
      if (prefix && !prefix.includes('*')) {
        if (touched === prefix || touched.startsWith(`${prefix}/`) || prefix.startsWith(`${touched}/`)) {
          return true;
        }
      }
    }
    for (const refPath of section.referencedPaths) {
      const cleanRef = toPosixPath(refPath).replace(/\/+\*\*$/, '').replace(/\/+$/, '');
      if (
        touched === cleanRef ||
        touched.startsWith(`${cleanRef}/`) ||
        cleanRef.startsWith(`${touched}/`)
      ) {
        return true;
      }
    }
  }

  // 2. Check executed Bash commands against section's referencedCommands
  for (const bashCmd of session.executedCommands) {
    const lowerBash = bashCmd.toLowerCase();
    for (const refCmd of section.referencedCommands) {
      const lowerRef = refCmd.toLowerCase().trim();
      if (lowerRef && lowerBash.includes(lowerRef)) {
        return true;
      }
    }

    // Also check if any token in the bash command is a file path matching inferredGlobs
    for (const token of bashCmd.split(/\s+/)) {
      if (token.includes('/') || /\.[a-zA-Z0-9]+$/.test(token)) {
        const norm = normalizeTouchedPath(token, '');
        if (norm && !norm.startsWith('-') && matchesGlobSet(norm, inferredGlobs)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function evaluateWorkspaceTraceRoi(
  ctx: WorkspaceContext,
): {
  sessionsAnalyzed: number;
  sections: SectionTraceRoi[];
  rawDiagnostics: Diagnostic[];
} {
  const traceDir = resolveTraceDirectory(ctx.cwd, ctx.options.traceDir);
  const jsonlFiles = traceDir ? listJsonlFiles(traceDir) : [];
  const sessions: ParsedSessionTrace[] = [];

  for (const file of jsonlFiles) {
    const parsed = parseSessionJsonlFile(file, ctx.cwd);
    if (parsed) {
      sessions.push(parsed);
    }
  }

  const sessionsAnalyzed = sessions.length;
  const sectionRois: SectionTraceRoi[] = [];
  const rawDiagnostics: Diagnostic[] = [];

  for (const hf of ctx.harnessFiles) {
    if (hf.format === 'mcp-config' || hf.format === 'claude-settings') {
      continue;
    }

    const totalSectionsInFile = hf.sections.length;

    for (const section of hf.sections) {
      const { isDomainSpecific, inferredGlobs } = inferSectionScope(
        section,
        ctx.repoFiles,
        totalSectionsInFile,
      );

      let sessionsHit = 0;
      for (const session of sessions) {
        if (doesSessionMatchSection(session, section, inferredGlobs)) {
          sessionsHit++;
        }
      }

      const sessionHitRate =
        sessionsAnalyzed > 0 ? Math.round((sessionsHit / sessionsAnalyzed) * 10000) / 100 : 0;

      const isDeadRuleSection =
        section.isAlwaysLoadedAtRoot &&
        isDomainSpecific &&
        sessionsAnalyzed >= 5 &&
        sessionsHit === 0;

      const tokenCount = estimateTokenCount(section.rawContent);

      const roi: SectionTraceRoi = {
        sectionId: section.id,
        sourceFile: section.sourceFile,
        heading: section.heading,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        tokenCount,
        isAlwaysLoadedAtRoot: section.isAlwaysLoadedAtRoot,
        isDomainSpecific,
        sessionsAnalyzed,
        sessionsHit,
        sessionHitRate,
        isDeadRuleSection,
        inferredGlobs,
      };
      sectionRois.push(roi);

      if (isDeadRuleSection) {
        rawDiagnostics.push({
          code: 'CTX009',
          severity: 'warning',
          message: `Dead Rule Section "${section.heading}" in ${section.sourceFile} has 0% Session Hit Rate across ${sessionsAnalyzed} recorded sessions (inferred scope: ${inferredGlobs.join(', ')})`,
          primaryLocation: {
            file: section.sourceFile,
            lineStart: section.lineStart,
            lineEnd: section.lineEnd,
            columnStart: section.columnStart,
            columnEnd: section.columnEnd,
            label: `0/${sessionsAnalyzed} sessions hit (${tokenCount} tokens in Turn-0 Load)`,
          },
          suggestion: `Extract "${section.heading}" into a path-scoped rule file (${inferredGlobs.join(', ')}) via \`deontic split --write\`.`,
          help: `Domain-specific Rule Sections loaded at repository root consume Turn-0 Load on every session even when their domain files are never touched.`,
          metadata: {
            sectionId: section.id,
            heading: section.heading,
            tokenCount,
            sessionsAnalyzed,
            sessionsHit,
            sessionHitRate,
            inferredGlobs,
          },
        });
      }
    }
  }

  return {
    sessionsAnalyzed,
    sections: sectionRois,
    rawDiagnostics,
  };
}

export function runTraceRoiPass(ctx: WorkspaceContext): Diagnostic[] {
  return evaluateWorkspaceTraceRoi(ctx).rawDiagnostics;
}

export async function correlateWorkspaceTraces(options: {
  cwd: string;
  traceDir?: string;
}): Promise<TraceCorrelationResult> {
  const config = loadWorkspaceConfig(options.cwd);
  const discovered = discoverWorkspaceFiles(options.cwd, config);

  const ctx: WorkspaceContext = {
    cwd: options.cwd,
    config,
    harnessFiles: discovered.harnessFiles,
    repoFiles: discovered.repoFiles,
    gitignorePatterns: discovered.gitignorePatterns,
    options: {
      cwd: options.cwd,
      traceDir: options.traceDir,
    },
  };

  const { sessionsAnalyzed, sections, rawDiagnostics } = evaluateWorkspaceTraceRoi(ctx);
  const diagnostics = filterAndMapDiagnostics(rawDiagnostics, ctx);

  return {
    cwd: options.cwd,
    sessionsAnalyzed,
    sections,
    diagnostics,
  };
}
