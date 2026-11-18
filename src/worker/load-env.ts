import { resolve } from 'node:path';
import { config } from 'dotenv';

const root = process.cwd();

export const projectRoot = root;

config({
  path: resolve(root, '.env'),
  quiet: true,
});
