export * from './types.js';
export { loadWorkspaceConfig } from './config/index.js';
export { discoverWorkspaceFiles } from './discovery/index.js';
export { resolveAgentProfiles, resolveEffectiveScope } from './scope/index.js';
export { parseHarnessFile } from './parser/index.js';
export { analyzeWorkspace } from './analyzer/index.js';
export { runImportsPass } from './analyzer/00-imports.js';
export { runContradictionPass } from './analyzer/01-contradiction.js';
export { runGroundTruthPass } from './analyzer/02-ground-truth.js';
export { runBloatCliffPass, profileWorkspaceCost } from './analyzer/03-bloat-cliff.js';
export {
  runMcpSchemaPass,
  probeMcpServers,
  detectParameterCasingCollisions,
} from './analyzer/04-mcp-schema.js';
export { runRedundancyPass } from './analyzer/05-redundancy.js';
export { runTraceRoiPass, correlateWorkspaceTraces } from './analyzer/06-trace-roi.js';
export { applyFixesToWorkspace } from './autofix/index.js';
export { splitWorkspace } from './autofix/path-splitter.js';
export { syncWorkspace } from './autofix/cross-sync.js';
