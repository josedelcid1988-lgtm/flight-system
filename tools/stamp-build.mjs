#!/usr/bin/env node
// Writes the build id and the SHA-256 of index.html into index.html, so every signature, history event,
// Support Overrides entry, mirrored record and printed document the app produces names the exact build.
//
//   node tools/stamp-build.mjs                 stamp index.html from VERSION.md (the build: line)
//   node tools/stamp-build.mjs --check         exit 1 unless index.html carries the current stamp
//   node tools/stamp-build.mjs --verify FILE   recompute the SHA-256 of any copy of index.html (a deployed
//                                              file, a copy attached to a record) and compare it to its stamp
//
// The hash cannot include itself, so it is defined as the SHA-256 of the file with the content of the
// fs-build-sha256 meta tag set to "unstamped". Anyone can recompute it: replace that one value, hash the
// file. Run it after every change to index.html and before tools/build-demo.mjs. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const VERSION = path.join(ROOT, 'VERSION.md');
const BUILD_RE = /<meta name="fs-build" content="([^"]*)">/;
const SHA_RE = /<meta name="fs-build-sha256" content="([^"]*)">/;

export function buildId(versionText) {
  const m = versionText.match(/^build:\s*(\S+)\s*$/m);
  if (!m) throw new Error('VERSION.md has no "build: <id>" line.');
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(m[1])) throw new Error(`VERSION.md build id "${m[1]}" is not a plain id (letters, digits, dot, dash, underscore).`);
  return m[1];
}

function tags(html) {
  const b = html.match(BUILD_RE), s = html.match(SHA_RE);
  if (!b || !s) throw new Error('The file has no fs-build and fs-build-sha256 meta tags in its head.');
  if (html.split('name="fs-build"').length !== 2 || html.split('name="fs-build-sha256"').length !== 2) throw new Error('The build meta tags appear more than once.');
  return { build: b[1], sha256: s[1] };
}

// The SHA-256 of the file with its own hash field set to "unstamped".
export function canonicalSha256(html) {
  tags(html);
  return crypto.createHash('sha256').update(html.replace(SHA_RE, '<meta name="fs-build-sha256" content="unstamped">'), 'utf8').digest('hex');
}

export function stamp(html, build) {
  tags(html);
  const withBuild = html.replace(BUILD_RE, `<meta name="fs-build" content="${build}">`);
  return withBuild.replace(SHA_RE, `<meta name="fs-build-sha256" content="${canonicalSha256(withBuild)}">`);
}

export function verify(html) {
  const t = tags(html), actual = canonicalSha256(html);
  return { build: t.build, stamped: t.sha256, actual, ok: t.sha256 === actual };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--verify')) {
    const file = argv[argv.indexOf('--verify') + 1];
    if (!file || !fs.existsSync(file)) { console.error('FAIL give the file to verify: node tools/stamp-build.mjs --verify <file>'); process.exit(1); }
    const v = verify(fs.readFileSync(file, 'utf8'));
    console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${file}: build ${v.build}, stamped ${v.stamped}, computed ${v.actual}`);
    process.exit(v.ok ? 0 : 1);
  }
  const html = fs.readFileSync(INDEX, 'utf8');
  const build = buildId(fs.readFileSync(VERSION, 'utf8'));
  const want = stamp(html, build);
  if (argv.includes('--check')) {
    if (want !== html) { const t = tags(html); console.error(`FAIL index.html is stamped build ${t.build}, ${t.sha256}; it should be build ${build}, ${verify(want).stamped}. Run node tools/stamp-build.mjs, then node tools/build-demo.mjs.`); process.exit(1); }
    console.log(`index.html stamp is current: build ${build}, SHA-256 ${verify(html).stamped}`);
    return;
  }
  if (want !== html) fs.writeFileSync(INDEX, want);
  console.log(`index.html stamped: build ${build}, SHA-256 ${verify(want).stamped}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error('FAIL ' + error.message); process.exit(1); }
}
