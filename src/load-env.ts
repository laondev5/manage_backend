import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

const root = process.cwd();

export const projectRoot = root;

config({
  path: resolve(root, '.env'),
  quiet: true,
});

function discoverMongod(): string | null {
  const bundled = resolve(root, '.data', 'mongodb');
  if (!existsSync(bundled)) return null;
  for (const directory of readdirSync(bundled)) {
    const candidate = resolve(bundled, directory, 'bin', 'mongod.exe');
    if (existsSync(candidate)) return candidate;
  }
  const unixCandidate = resolve(bundled, 'bin', 'mongod');
  return existsSync(unixCandidate) ? unixCandidate : null;
}

if (!process.env.MONGOMS_SYSTEM_BINARY) {
  const mongod = discoverMongod();
  if (mongod) process.env.MONGOMS_SYSTEM_BINARY = mongod;
}
