import { runCli } from '@deontic/cli';

export interface ActionInput {
  command?: string;
  strict?: boolean;
  format?: 'pretty' | 'json' | 'sarif' | 'github';
  cwd?: string;
}

export async function runAction(
  input: ActionInput = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = (input.command ?? process.env.INPUT_COMMAND ?? 'check').trim();
  const strict = input.strict ?? process.env.INPUT_STRICT === 'true';
  const format = input.format ?? (process.env.INPUT_FORMAT as ActionInput['format']) ?? 'github';
  const cwd = input.cwd ?? process.env['INPUT_WORKING-DIRECTORY'] ?? process.cwd();

  const argv: string[] = command.split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    argv.push('check');
  }

  if (argv[0] === 'check') {
    if (!argv.includes('--format')) {
      argv.push('--format', format);
    }
    if (strict && !argv.includes('--strict')) {
      argv.push('--strict');
    }
  } else if (argv[0] === 'sync') {
    if (!argv.includes('--check') && !argv.includes('--write')) {
      argv.push('--check');
    }
    if (input.format === 'json' && !argv.includes('--format')) {
      argv.push('--format', 'json');
    }
  }

  return runCli(argv, { cwd });
}

// Execute automatically when invoked directly by GitHub Actions runner
if (process.env.GITHUB_ACTIONS === 'true' && process.env.VITEST !== 'true') {
  runAction()
    .then((res) => {
      if (res.stdout) process.stdout.write(res.stdout + '\n');
      if (res.stderr) process.stderr.write(res.stderr + '\n');
      process.exitCode = res.exitCode;
    })
    .catch((err) => {
      process.stderr.write(String(err) + '\n');
      process.exitCode = 1;
    });
}
