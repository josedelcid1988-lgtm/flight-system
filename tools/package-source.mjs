#!/usr/bin/env node
// Build a reproducible source-and-verification archive for handoff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './package-release.mjs';
import { buildId } from './stamp-build.mjs';

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

// The archive is named from VERSION.md, so index.html and demo.html must both identify as that build: a
// VERSION.md bumped before the pages were rebuilt would otherwise name pages that still carry the old build.
export function sourceBuildProblem(build, pages) {
  for (const [name, html] of Object.entries(pages)) {
    const tag = (html.match(/<meta name="fs-build" content="([^"]*)">/) || [])[1];
    if (tag !== build) return `${name} carries fs-build ${tag || 'none'} but VERSION.md sets ${build}. Run node tools/stamp-build.mjs --clear and node tools/build-demo.mjs, then package the source.`;
  }
  return null;
}

export function packageSource(outDir = path.join(ROOT, 'release')) {
  // The source package holds the committed tree, so its build id comes from VERSION.md, not from a stamp.
  const build = buildId(fs.readFileSync(path.join(ROOT, 'VERSION.md'), 'utf8'));
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const problem = sourceBuildProblem(build, { 'index.html': read('index.html'), 'demo.html': read('demo.html') });
  if (problem) throw new Error(problem);
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
