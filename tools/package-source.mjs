#!/usr/bin/env node
// Build a reproducible source-and-verification archive for handoff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildId, makeZip } from './package-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDED_DIRS = ['.github', 'artifacts/design', 'assets', 'docs', 'planner', 'qms', 'server', 'src', 'tests', 'tools'];
const INCLUDED_FILES = [
  '.gitignore', 'AGENTS.md', 'CHANGELOG.md', 'HANDOVER-v82.md', 'KNOWN-ISSUES.md', 'README.md', 'TESTING.md', 'VERSION.md',
  'index.html', 'demo.html', 'package.json', 'package-lock.json'
];
const OMIT = /(^|\/)(?:\.git|node_modules|release|dist|\.playwright-mcp)(\/|$)|(?:^|\/)\.DS_Store$|(?:^|\/)suite_[^/]+\.log$|(?:^|\/)suite_results(?:_mirror)?\.json$|(?:^|\/)qa_[^/]+_results\.json$/;

function filesUnder(relative) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => filesUnder(path.posix.join(relative.replaceAll(path.sep, '/'), entry.name)));
}

export function sourceManifest() {
  return [...new Set([...INCLUDED_FILES, ...INCLUDED_DIRS.flatMap(filesUnder)])]
    .filter(name => !OMIT.test(name) && fs.existsSync(path.join(ROOT, name)) && fs.statSync(path.join(ROOT, name)).isFile())
    .sort((a, b) => a.localeCompare(b));
}

export function packageSource(outDir = path.join(ROOT, 'release')) {
  const build = buildId();
  const file = path.join(outDir, `flight-system-v${build.replace(/^v/, '')}-source.zip`);
  fs.mkdirSync(outDir, { recursive: true });
  const names = sourceManifest();
  fs.writeFileSync(file, makeZip(names.map(name => [name, fs.readFileSync(path.join(ROOT, name))])));
  return { file, entries: names.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--out');
    const outDir = path.resolve(at >= 0 ? process.argv[at + 1] : path.join(ROOT, 'release'));
    const result = packageSource(outDir);
    console.log(`source package: ${result.file} (${result.entries} files)`);
  } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
}
