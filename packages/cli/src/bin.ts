import { runCli } from './index.js';

const result = await runCli(process.argv.slice(2), { cwd: process.cwd() });
if (result.stdout) {
  process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
}
if (result.stderr) {
  process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
}
process.exit(result.exitCode);
