import { runCli } from '@deontic/cli';

export interface ActionInput {
  command?: string;
  strict?: boolean;
  format?: 'pretty' | 'json' | 'sarif' | 'github';
  cwd?: string;
}

export async function runAction(input: ActionInput = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = input.command ?? process.env.INPUT_COMMAND ?? 'check';
  const strict = input.strict ?? process.env.INPUT_STRICT === 'true';
  const format = (input.format ?? (process.env.INPUT_FORMAT as ActionInput['format']) ?? 'github');
  const cwd = input.cwd ?? process.env['INPUT_WORKING-DIRECTORY'] ?? process.cwd();

  const argv: string[] = command.split(/\s+/).filter(Boolean);
  if (command.startsWith('check') || argv[0] === 'check') {
    if (!argv.includes('--format')) {
      argv.push('--format', format);
    }
    if (strict && !argv.includes('--strict')) {
      argv.push('--strict');
    }
  }

  return runCli(argv, { cwd });
}
