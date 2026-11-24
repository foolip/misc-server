#!/usr/bin/env node
// Generates config/lock-rules.json: R2 bucket lock rules that make every
// host's commit-snapshots/ and review-drafts/ write-once (no overwrites, no
// deletes), for every host in config/hosts.json that serves files.
//
//   node tools/lock-rules.mjs           # write config/lock-rules.json
//   node tools/lock-rules.mjs --check   # exit 1 if it is out of date
//
// Apply with (replaces all lock rules on the bucket):
//   npm run lock-rules:apply

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(HERE, '..', 'config');
const OUTPUT = path.join(CONFIG_DIR, 'lock-rules.json');

export const LOCKED_DIRS = ['commit-snapshots', 'review-drafts'];

export function lockRules(config) {
  const rules = [];
  for (const [host, conf] of Object.entries(config.hosts).sort(([a], [b]) => a < b ? -1 : 1)) {
    if (!conf.serveFiles) continue;
    for (const dir of LOCKED_DIRS) {
      rules.push({
        id: `${host}-${dir}`,
        enabled: true,
        prefix: `${host}/${dir}/`,
        condition: { type: 'Indefinite' },
      });
    }
  }
  return { rules };
}

export function render(config) {
  const { rules } = lockRules(config);
  return '{\n  "rules": [\n' + rules.map(r => '    ' + JSON.stringify(r)).join(',\n') + '\n  ]\n}\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'hosts.json'), 'utf8'));
  const output = render(config);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== output) {
      console.error('config/lock-rules.json is out of date. Run `npm run lock-rules` in cloudflare/ and commit the result.');
      process.exit(1);
    }
    console.log('config/lock-rules.json is up to date.');
  } else {
    fs.writeFileSync(OUTPUT, output);
    console.log(`Wrote config/lock-rules.json (${JSON.parse(output).rules.length} rules)`);
  }
}
