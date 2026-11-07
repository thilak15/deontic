import fs from 'node:fs';
import path from 'node:path';
import type { DeonticConfig, ResolvedDeonticConfig } from '../types.js';

export function loadWorkspaceConfig(cwd: string, override?: DeonticConfig): ResolvedDeonticConfig {
  let fileConfig: DeonticConfig = {};

  const deonticJsonPath = path.join(cwd, 'deontic.json');
  const pkgJsonPath = path.join(cwd, 'package.json');

  if (fs.existsSync(deonticJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(deonticJsonPath, 'utf8')) as DeonticConfig;
      if (parsed && typeof parsed === 'object') {
        fileConfig = parsed;
      }
    } catch {
      // Ignore malformed deontic.json
    }
  } else if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
      if (pkg && typeof pkg.deontic === 'object' && pkg.deontic !== null) {
        fileConfig = pkg.deontic as DeonticConfig;
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  return {
    ignore: override?.ignore ?? fileConfig.ignore ?? [],
    maxDirectives: override?.maxDirectives ?? fileConfig.maxDirectives ?? 150,
    maxMcpTools: override?.maxMcpTools ?? fileConfig.maxMcpTools ?? 40,
    maxFileBytes: override?.maxFileBytes ?? fileConfig.maxFileBytes ?? 32768,
    rules: {
      ...(fileConfig.rules ?? {}),
      ...(override?.rules ?? {}),
    },
  };
}
