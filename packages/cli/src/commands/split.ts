import { splitWorkspace } from '@deontic/core';

export interface SplitCommandOptions {
  cwd: string;
  target?: 'claude' | 'cursor';
  write?: boolean;
  fix?: boolean;
  format?: 'pretty' | 'json';
}

export async function runSplitCommand(options: SplitCommandOptions): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = await splitWorkspace(options);
  if (options.format === 'json') {
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2), stderr: '' };
  }

  const lines: string[] = [];
  lines.push(
    `=== Deontic Progressive-Disclosure Split (${result.written ? 'WRITTEN' : 'DRY-RUN PREVIEW'}) ===`,
  );
  lines.push(
    `Turn-0 Load Reduction: ${result.turn0TokensBefore} -> ${result.turn0TokensAfter} tokens (-${result.reductionPercent}%)`,
  );
  lines.push('');

  if (result.proposedFiles.length === 0) {
    lines.push('No extractable domain-specific Rule Sections found.');
  } else {
    lines.push(`Proposed Path-Scoped Files (${result.proposedFiles.length}):`);
    for (const pf of result.proposedFiles) {
      lines.push(
        `  - ${pf.targetPath} (from ${pf.sourceFile}, globs: [${pf.inferredGlobs.join(', ')}], saves ${pf.tokenSavings} Turn-0 tokens)`,
      );
    }
  }

  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
