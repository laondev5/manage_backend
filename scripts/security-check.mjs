// Check Git-tracked/staged files without printing credential values.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const root = resolve(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const envFile = resolve(root, '.env');
const env = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
const secretKeys = ['MONGODB_URI', 'BETTER_AUTH_SECRET', 'WORKER_TRIGGER_SECRET', 'CRON_SECRET',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'EXPO_ACCESS_TOKEN'];
const secrets = secretKeys.map(key => env[key]).filter(value => value && value.length >= 16);
const findings = [];
for (const file of files) {
  if (/(^|\/)\.env(?:$|\.)/.test(file) && !file.endsWith('.env.example')) {
    findings.push(`${file}: private environment file is tracked`);
  }
  if (/^(node_modules|dist)\//.test(file)) findings.push(`${file}: generated dependency/build file is tracked`);
  if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|md|example)$/.test(file)) continue;
  const full = resolve(root, file);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, 'utf8');
  if (secrets.some(value => text.includes(value))) findings.push(`${file}: contains a configured private credential`);
  if (!file.endsWith('.env.example') && /mongodb(?:\+srv)?:\/\/[^\s/'"]+:[^\s/'"]+@/.test(text)) {
    findings.push(`${file}: contains a database URI with embedded credentials`);
  }
}
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Secret check passed for ${files.length} tracked/staged files; values were not printed.`);
}
