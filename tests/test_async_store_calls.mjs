import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../server/server.mjs', import.meta.url), 'utf8');
const failures = [];
const call = /(?<![\w.])(?:store|tx)\.([A-Za-z_$][\w$]*)\s*\(/g;
for (const match of source.matchAll(call)) {
  const lineStart = source.lastIndexOf('\n', match.index) + 1;
  const prefix = source.slice(lineStart, match.index);
  if (!/\bawait\s*$/.test(prefix)) {
    const line = source.slice(0, match.index).split('\n').length;
    failures.push(`line ${line}: ${match[0]}`);
  }
}
assert.deepEqual(failures, [], `Every storage call in server/server.mjs must be awaited:\n${failures.join('\n')}`);
console.log('ok every server storage call is awaited');
