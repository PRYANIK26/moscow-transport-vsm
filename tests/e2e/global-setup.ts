import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const host = '127.0.0.1';
const pgArgs = ['-h', host, '-p', '55432', '-U', 'vsm'];
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function ready(url: string, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* service still starting */
    }
    await wait(250);
  }
  throw new Error(`E2E service did not start: ${url}`);
}

export default async function setup() {
  if (process.env.E2E_BASE_URL) return;
  const dbName = `vsm_e2e_test_${process.pid}_${Date.now()}`;
  const databaseUrl = `postgresql://vsm@${host}:55432/${dbName}`;
  const children: ChildProcess[] = [];
  const logs = join(root, '.runtime', 'e2e');
  mkdirSync(logs, { recursive: true });
  function start(name: string, bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const log = openSync(join(logs, `${dbName}-${name}.log`), 'a');
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    children.push(child);
    return child;
  }
  async function cleanup() {
    for (const child of children.reverse()) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
    }
    await wait(800);
    for (const child of children) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    }
    execFileSync('dropdb', [...pgArgs, '--if-exists', '--force', dbName], { cwd: root });
  }
  try {
    for (const url of ['http://127.0.0.1:4192/api/health', 'http://127.0.0.1:5192/']) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(500) });
        throw new Error(`E2E port already in use: ${url}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('E2E port')) throw error;
      }
    }
    execFileSync('createdb', [...pgArgs, dbName], { cwd: root });
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DEMO_SEED: 'true',
      WEB_ORIGIN: 'http://127.0.0.1:5192',
      PORT: '4192',
      HOST: host,
    };
    execFileSync(join(root, 'node_modules/.bin/tsx'), ['src/setup.ts'], {
      cwd: join(root, 'apps/api'),
      env,
      stdio: 'pipe',
    });
    start(
      'api',
      join(root, 'node_modules/.bin/tsx'),
      ['src/server.ts'],
      join(root, 'apps/api'),
      env,
    );
    await ready('http://127.0.0.1:4192/api/health');
    start(
      'worker',
      join(root, 'node_modules/.bin/tsx'),
      ['src/worker.ts'],
      join(root, 'apps/api'),
      env,
    );
    start(
      'web',
      join(root, 'node_modules/.bin/vite'),
      ['--host', host, '--port', '5192', '--strictPort'],
      join(root, 'apps/web'),
      { ...env, API_PROXY_TARGET: 'http://127.0.0.1:4192' },
    );
    await ready('http://127.0.0.1:5192/');
    process.env.E2E_DATABASE_URL = databaseUrl;
    console.log(`E2E isolated database: ${dbName}`);
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch {
      /* keep initial setup error */
    }
    throw error;
  }
}
