import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageSource, sourceManifest } from '../tools/package-source.mjs';
import { readZip } from '../tools/package-release.mjs';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-source-package-'));
try {
  const result = packageSource(out);
  const entries = readZip(fs.readFileSync(result.file));
  const names = entries.map(([name]) => name);
  assert.equal(names.length, result.entries);
  assert.deepEqual(names, sourceManifest());
  for (const required of ['README.md', 'HANDOVER-v82.md', 'index.html', 'src/react/flight-ui.jsx', 'server/server.mjs', 'tests/qa_full.mjs', 'docs/RELEASE-SUMMARY-v82.md', 'artifacts/design/final/hangar-1440.png']) assert.ok(names.includes(required), `${required} is missing from the source package`);
  assert.ok(names.some(name => name.endsWith('.webm')), 'browser interaction recording is missing');
  assert.ok(!names.some(name => /(^|\/)(\.git|node_modules|release|dist)(\/|$)/.test(name)));
  assert.ok(!names.some(name => /suite_.*\.log$|suite_results/.test(name)));
  console.log(`source package: ${names.length} portable files, CRC verified`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
