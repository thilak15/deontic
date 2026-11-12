export type ImperativeModality = 'MUST' | 'SHOULD' | 'MUST_NOT' | 'SHOULD_NOT';

export type AgentProfileId = 'claude-code' | 'cursor' | 'codex' | 'copilot';

export type DiagnosticCode =
  | 'CTX001'
  | 'CTX002'
  | 'CTX003'
  | 'CTX004'
  | 'CTX005'
  | 'CTX006'
  | 'CTX007'
  | 'CTX008'
  | 'CTX009';

export type DiagnosticSeverity = 'error' | 'warning';

export type HarnessFormat =
  | 'claude-md'
  | 'claude-rule'
  | 'claude-skill'
  | 'claude-settings'
  | 'cursor-mdc'
  | 'cursorrules'
  | 'agents-md'
  | 'gemini-md'
  | 'windsurfrules'
  | 'copilot-instructions'
  | 'copilot-scoped'
  | 'mcp-config';

export interface HarnessFrontmatter {
  paths?: string[];
  globs?: string[];
  applyTo?: string[];
  alwaysApply?: boolean;
  description?: string;
  raw?: Record<string, unknown>;
}

export interface DirectiveNode {
  id: string;
  sourceFile: string;
  sectionId: string;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  rawText: string;
  effectiveGlobs: string[];
  isAlwaysLoadedAtRoot: boolean;
  modality: ImperativeModality;
  topic: string;
  predicate: {
    action: string;
    target: string;
    condition?: string;
  };
  referencedPaths: string[];
  referencedCommands: string[];
  suppressedCodes: string[];
  overrideGlobs: string[];
  deprecatedContext?: boolean;
}

export interface ContextNote {
  id: string;
  sourceFile: string;
  sectionId: string;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  rawText: string;
  referencedPaths: string[];
  referencedCommands: string[];
  isDerivableDirectoryTree?: boolean;
  treeKind?: 'ascii-tree' | 'path-catalog';
  suppressedCodes: string[];
}

export interface ImportRef {
  rawImport: string;
  targetPath: string;
  sourceFile: string;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  suppressedCodes: string[];
}

export interface RuleSection {
  id: string;
  sourceFile: string;
  heading: string;
  headingLevel: number;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  rawContent: string;
  effectiveGlobs: string[];
  isAlwaysLoadedAtRoot: boolean;
  directives: DirectiveNode[];
  contextNotes: ContextNote[];
  referencedPaths: string[];
  referencedCommands: string[];
  suppressedCodes: string[];
  overrideGlobs: string[];
  syncMarker?: {
    id: string;
    globs: string[];
  };
}

export interface HarnessFile {
  path: string;
  absolutePath: string;
  format: HarnessFormat;
  agentProfiles: AgentProfileId[];
  rawContent: string;
  byteSize: number;
  tokenCount: number;
  frontmatter?: HarnessFrontmatter;
  effectiveGlobs: string[];
  isAlwaysLoadedAtRoot: boolean;
  sections: RuleSection[];
  directives: DirectiveNode[];
  contextNotes: ContextNote[];
  imports: ImportRef[];
  suppressedCodes: string[];
  overrideGlobs: string[];
}

export interface DiagnosticLocation {
  file: string;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  snippet?: string;
  label?: string;
}

export interface TextEdit {
  file: string;
  lineStart?: number;
  lineEnd?: number;
  oldText?: string;
  newText: string;
  replaceFullFile?: boolean;
}

export interface DiagnosticFix {
  description: string;
  edits: TextEdit[];
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  primaryLocation: DiagnosticLocation;
  secondaryLocations?: DiagnosticLocation[];
  witnessPath?: string;
  suggestion?: string;
  help?: string;
  agentProfile?: AgentProfileId;
  fix?: DiagnosticFix;
  metadata?: Record<string, unknown>;
}

export type RuleSeveritySetting = 'error' | 'warn' | 'warning' | 'off';

export interface DeonticConfig {
  ignore?: string[];
  maxDirectives?: number;
  maxMcpTools?: number;
  maxFileBytes?: number;
  rules?: Partial<Record<DiagnosticCode, RuleSeveritySetting>>;
}

export interface ResolvedDeonticConfig {
  ignore: string[];
  maxDirectives: number;
  maxMcpTools: number;
  maxFileBytes: number;
  rules: Partial<Record<DiagnosticCode, RuleSeveritySetting>>;
}

export interface AnalyzeOptions {
  cwd: string;
  agent?: AgentProfileId;
  strict?: boolean;
  fix?: boolean;
  probe?: boolean;
  traceDir?: string;
  config?: DeonticConfig;
}

export interface WorkspaceContext {
  cwd: string;
  config: ResolvedDeonticConfig;
  harnessFiles: HarnessFile[];
  repoFiles: string[];
  gitignorePatterns: string[];
  options: AnalyzeOptions;
}

export interface WorkspaceAnalysisResult {
  cwd: string;
  harnessFiles: HarnessFile[];
  repoFiles: string[];
  diagnostics: Diagnostic[];
  appliedFixes: DiagnosticFix[];
  config: ResolvedDeonticConfig;
  excludedCheckouts: string[];
}

export interface ProfileFileCost {
  path: string;
  byteSize: number;
  tokenCount: number;
  directiveCount: number;
  contextNoteCount: number;
  wastedTreeTokens: number;
  isAlwaysLoadedAtRoot: boolean;
}

export interface McpToolParameterCollision {
  canonicalKey: string;
  parameters: Array<{
    serverName: string;
    toolName: string;
    paramName: string;
    casingStyle: 'snake_case' | 'camelCase' | 'kebab-case' | 'PascalCase' | 'other';
  }>;
}

export interface McpServerProfile {
  serverName: string;
  sourceFile: string;
  command: string;
  args: string[];
  toolCount: number;
  tokenCount: number;
  source: 'registry' | 'heuristic' | 'live-probe';
  tools: Array<{
    name: string;
    description?: string;
    tokenCount: number;
    parameterNames: string[];
  }>;
  error?: string;
}

export interface AgentProfileBudget {
  agentProfile: AgentProfileId;
  turn0Tokens: number;
  turn0Bytes: number;
  turn0Directives: number;
  totalTokens: number;
  totalDirectives: number;
  wastedTreeTokens: number;
  mcpTokens: number;
  mcpToolCount: number;
  files: ProfileFileCost[];
  mcpServers: McpServerProfile[];
  mcpCollisions: McpToolParameterCollision[];
}

export interface CostProfileResult {
  cwd: string;
  profiles: Record<AgentProfileId, AgentProfileBudget>;
  diagnostics: Diagnostic[];
}

export interface SectionTraceRoi {
  sectionId: string;
  sourceFile: string;
  heading: string;
  lineStart: number;
  lineEnd: number;
  tokenCount: number;
  isAlwaysLoadedAtRoot: boolean;
  isDomainSpecific: boolean;
  sessionsAnalyzed: number;
  sessionsHit: number;
  sessionHitRate: number;
  isDeadRuleSection: boolean;
  inferredGlobs: string[];
}

export interface TraceCorrelationResult {
  cwd: string;
  sessionsAnalyzed: number;
  sections: SectionTraceRoi[];
  diagnostics: Diagnostic[];
}

export interface ProposedSplitFile {
  targetPath: string;
  sourceFile: string;
  sections: RuleSection[];
  inferredGlobs: string[];
  content: string;
  tokenSavings: number;
  lineCount: number;
}

export interface SplitWorkspaceOptions {
  cwd: string;
  target?: 'claude' | 'cursor';
  write?: boolean;
  fix?: boolean;
}

export interface SplitWorkspaceResult {
  cwd: string;
  target: 'claude' | 'cursor';
  written: boolean;
  proposedFiles: ProposedSplitFile[];
  updatedRootFiles: Array<{
    path: string;
    originalTokens: number;
    remainingTokens: number;
    content: string;
  }>;
  turn0TokensBefore: number;
  turn0TokensAfter: number;
  reductionPercent: number;
}

export interface SyncWorkspaceOptions {
  cwd: string;
  from?: 'claude' | 'cursor';
  write?: boolean;
  check?: boolean;
}

export interface SyncTargetFile {
  path: string;
  content: string;
  drifted: boolean;
}

export interface SyncWorkspaceResult {
  cwd: string;
  from: 'claude' | 'cursor';
  written: boolean;
  inSync: boolean;
  targets: SyncTargetFile[];
}
