import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(new URL('../.env', import.meta.url)))
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://vsm@127.0.0.1:55432/vsm',
  PORT: process.env.PORT ?? '4180',
  HOST: process.env.HOST ?? '127.0.0.1',
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5180',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};
const commands = [
  ['run', 'start', '-w', '@vsm/api'],
  ['run', 'worker', '-w', '@vsm/api'],
  ['run', 'dev', '-w', '@vsm/web'],
];
const children = commands.map((args) =>
  spawn('npm', args, { cwd, env, stdio: 'inherit', detached: true }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(code), 1200).unref();
}
children.forEach((p) => {
  p.on('error', (e) => {
    console.error(e);
    stop(1);
  });
  p.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
