#!/usr/bin/env node
// Builds the two release zips for the build stamped in index.html:
//   flight-system-<build>.zip        index.html and assets/ (production)
//   flight-system-<build>-demo.zip   demo.html and assets/ (demo, DEMO, NOT FOR ACCEPTANCE)
//
//   node tools/package-release.mjs [--out DIR]    write both zips (default DIR: release/)
//   node tools/package-release.mjs --verify DIR   check both zips in DIR match the files in the tree
//
// A zip is only a container here: files are stored uncompressed (the pages are text that a web server
// compresses anyway, the assets are already JPEG and PNG), with fixed timestamps and sorted entries, so
// the same tree always produces byte-identical zips. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify } from './stamp-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00, fixed for reproducible zips

// The build id of the stamped index.html. Refuses the committed form (hash placeholder "unstamped") and a
// stamp that does not match the file, so a release zip always carries a verifiable SHA-256.
export function buildId(html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) {
  const v = verify(html);
  if (!v.build || v.build === 'unstamped' || v.stamped === 'unstamped') throw new Error('index.html is not stamped. Run node tools/stamp-build.mjs, then node tools/build-demo.mjs, first.');
  if (!v.ok) throw new Error(`index.html carries SHA-256 ${v.stamped} but the file computes ${v.actual}. Run node tools/stamp-build.mjs, then node tools/build-demo.mjs.`);
  return v.build;
}

// The demo build is generated from the stamped index.html, so it must carry the same build id and SHA-256.
export function demoProblem(indexHtml, demoHtml) {
  const tag = (html, name) => (html.match(new RegExp(`<meta name="${name}" content="([^"]*)">`)) || [])[1];
  for (const name of ['fs-build', 'fs-build-sha256']) {
    if (tag(demoHtml, name) !== tag(indexHtml, name)) return `demo.html carries ${name} ${tag(demoHtml, name) || 'none'} but index.html carries ${tag(indexHtml, name)}. Run node tools/build-demo.mjs after stamping.`;
  }
  return null;
}

// Both builds checked before either zip is written or verified.
function releaseBuild() {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const html = read('index.html'), build = buildId(html), problem = demoProblem(html, read('demo.html'));
  if (problem) throw new Error(problem);
  return build;
}

// The files each zip carries: [path inside the zip, path in the tree].
export function manifest(kind, root = ROOT) {
  const page = kind === 'demo' ? 'demo.html' : 'index.html';
  const assets = fs.readdirSync(path.join(root, 'assets')).filter(f => !f.startsWith('.')).sort().map(f => [`assets/${f}`, `assets/${f}`]);
  return [[page, page], ...assets];
}

// The packager ships the files directly in assets/, so anything else there (a subdirectory, a link) would be
// left out of the zips or fail to read. Returns a plain problem, or null.
export function assetsLayoutProblem(root = ROOT) {
  const odd = fs.readdirSync(path.join(root, 'assets'), { withFileTypes: true }).filter(e => !e.name.startsWith('.') && !e.isFile())
    .map(e => `assets/${e.name} is ${e.isDirectory() ? 'a directory' : 'not a regular file'}`).sort();
  return odd.length ? `${odd.join('; ')}. The release packages only files directly in assets/; move or remove ${odd.length > 1 ? 'them' : 'it'}, then stamp from a commit without ${odd.length > 1 ? 'them' : 'it'}.` : null;
}

// Every packaged asset must be reproducible byte for byte from the named commit, so that commit reproduces the
// zips. The bytes on disk, exactly as they would ship, are hashed without any filter (git hash-object
// --no-filters) and compared with the commit's tree, so no index state (untracked, ignored, renamed,
// assume-unchanged, skip-worktree) can hide a difference. A file matches when its bytes are the committed blob,
// or are exactly what a checkout of that blob writes on this machine (git cat-file --filters applies the smudge
// and end-of-line conversion from .gitattributes and core.autocrlf), so a checkout with clean filters is not
// refused for its own conversion, while bytes a clean filter would merely normalize are still refused.
// Returns a plain problem, or null.
export function assetsProblem({ root = ROOT, commit = 'HEAD' } = {}) {
  const run = (args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options });
  const git = (...args) => run(args, { encoding: 'utf8' });
  let tree;
  try { tree = git('ls-tree', '-z', commit, '--', 'assets/'); }
  catch { return `assets/ could not be read from commit ${commit}. Release from a git checkout of the release commit.`; }
  const committed = new Map(tree.split('\0').filter(Boolean).map(entry => {
    const [meta, name] = entry.split('\t'), [, type, hash] = meta.split(' ');
    return [name, type === 'blob' ? hash : type];
  }).filter(([name]) => !path.basename(name).startsWith('.')));
  const layout = assetsLayoutProblem(root);
  if (layout) return layout;
  const packaged = manifest('production', root).slice(1).map(([, inTree]) => inTree);
  const hashes = packaged.length ? git('hash-object', '--no-filters', '--', ...packaged).trim().split('\n') : [];
  const onDisk = new Map(packaged.map((name, i) => [name, hashes[i]]));
  for (const [name, hash] of onDisk) {
    const blob = committed.get(name);
    if (!blob || blob === hash || !/^[0-9a-f]{40,64}$/.test(blob)) continue;
    const checkout = run(['cat-file', '--filters', `${commit}:${name}`]);
    if (run(['hash-object', '--no-filters', '--stdin'], { input: checkout, encoding: 'utf8' }).trim() === hash) onDisk.set(name, blob);
  }
  return assetsDiff(committed, onDisk, commit);
}

// The comparison behind assetsProblem: committed and packaged map assets/<name> to its git blob hash.
export function assetsDiff(committed, packaged, commit = 'HEAD') {
  const problems = [];
  for (const [name, hash] of packaged) {
    if (!committed.has(name)) problems.push(`${name} is not in ${commit}`);
    else if (committed.get(name) !== hash) problems.push(`${name} differs from ${commit}`);
  }
  for (const name of committed.keys()) if (!packaged.has(name)) problems.push(`${name} is in ${commit} but missing on disk`);
  return problems.length ? `assets/ does not match ${commit} (${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; ...' : ''}), so the release commit would not reproduce the packaged files. Commit or discard those changes, then stamp from that commit.` : null;
}

export function zipNames(build) { return { production: `flight-system-${build}.zip`, demo: `flight-system-${build}-demo.zip` }; }

export function makeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// Reads a stored (uncompressed) zip back into [name, data] pairs, checking every CRC.
export function readZip(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(endAt + 10); let p = buf.readUInt32LE(endAt + 16); const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error(`${name} is compressed; this tool writes stored entries only`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`${name} fails its CRC check`);
    out.push([name, data]); p += 46 + nameLen + extra + comment;
  }
  return out;
}

// Checks assets/ against HEAD before writing, so every caller that writes release zips is gated, not only the
// command line: an asset changed after the record was written would otherwise ship under a record naming a
// commit that does not hold it. allowUncommittedAssets packages the working tree as it is; only
// tests/qa_full.mjs uses it, to check the packager on a development tree, and its zips are never released.
export function packageRelease(outDir, { allowUncommittedAssets = false } = {}) {
  const build = releaseBuild(), names = zipNames(build);
  const assets = allowUncommittedAssets ? assetsLayoutProblem() : assetsProblem();
  if (assets) throw new Error(assets);
  fs.mkdirSync(outDir, { recursive: true });
  for (const kind of ['production', 'demo']) {
    const entries = manifest(kind).map(([inZip, inTree]) => [inZip, fs.readFileSync(path.join(ROOT, inTree))]);
    fs.writeFileSync(path.join(outDir, names[kind]), makeZip(entries));
  }
  return { build, files: Object.values(names).map(n => path.join(outDir, n)) };
}

// Every problem found, or an empty list when both zips match the tree exactly.
export function verifyRelease(outDir) {
  const build = releaseBuild(), names = zipNames(build), problems = [];
  for (const kind of ['production', 'demo']) {
    const file = path.join(outDir, names[kind]);
    if (!fs.existsSync(file)) { problems.push(`${names[kind]} is missing from ${outDir}`); continue; }
    let got;
    try { got = new Map(readZip(fs.readFileSync(file))); } catch (error) { problems.push(`${names[kind]}: ${error.message}`); continue; }
    const want = manifest(kind);
    if (got.size !== want.length) problems.push(`${names[kind]} holds ${got.size} files; expected ${want.length}`);
    for (const [inZip, inTree] of want) {
      const data = got.get(inZip);
      if (!data) problems.push(`${names[kind]} is missing ${inZip}`);
      else if (!data.equals(fs.readFileSync(path.join(ROOT, inTree)))) problems.push(`${names[kind]}: ${inZip} differs from ${inTree} in the tree`);
    }
  }
  return problems;
}

function main() {
  const argv = process.argv.slice(2), at = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--verify')) {
    const dir = at('--verify');
    if (!dir) throw new Error('give the folder that holds the zips: --verify DIR');
    const problems = verifyRelease(path.resolve(dir));
    if (problems.length) { problems.forEach(p => console.error('FAIL ' + p)); process.exit(1); }
    console.log(`release zips for ${buildId()} in ${dir} match the tree`);
    return;
  }
  // packageRelease() checks assets/ against HEAD again, not only the release record does.
  const r = packageRelease(path.resolve(at('--out') || path.join(ROOT, 'release')));
  console.log(`packaged ${r.build}:\n  ${r.files.join('\n  ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error('FAIL ' + error.message); process.exit(1); }
}
