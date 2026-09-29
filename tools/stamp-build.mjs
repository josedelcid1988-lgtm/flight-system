#!/usr/bin/env node
// Writes the build id and the SHA-256 of index.html into index.html, so every signature, history event,
// Support Overrides entry, mirrored record and printed document the app produces names the exact build.
//
// The stamp is generated, never committed. The committed index.html carries the build id from VERSION.md
// and the placeholder hash "unstamped", so pull requests do not conflict on it after every merge. CI stamps
// its working copy on every run and tests the stamped build; the release process stamps the build it ships.
//
//   node tools/stamp-build.mjs                 stamp the working copy of index.html (for a test run or a
//                                              release; do not commit it), then run tools/build-demo.mjs
//   node tools/stamp-build.mjs --clear         put the committed form back: the VERSION.md build id and the
//                                              placeholder hash; run tools/build-demo.mjs after it
//   node tools/stamp-build.mjs --check         exit 1 unless index.html is in its committed form
//   node tools/stamp-build.mjs --verify FILE   recompute the SHA-256 of any copy of index.html (a deployed
//                                              file, a copy attached to a record) and compare it to its stamp;
//                                              an unstamped copy fails
//
// The hash cannot include itself, so it is defined as the SHA-256 of the file with the content of the
// fs-build-sha256 meta tag set to "unstamped". Anyone can recompute it: replace that one value, hash the
// file. Node built-ins only.
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

// The committed form: the build id, and the placeholder in place of the generated hash.
export function clear(html, build) {
  tags(html);
  return html.replace(BUILD_RE, `<meta name="fs-build" content="${build}">`).replace(SHA_RE, '<meta name="fs-build-sha256" content="unstamped">');
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
  const committed = clear(html, build);
  if (argv.includes('--check')) {
    if (committed !== html) { const t = tags(html); console.error(`FAIL index.html carries build ${t.build} and hash ${t.sha256}; the committed file carries build ${build} and the placeholder "unstamped". The stamp is generated in CI and at release, not committed. Run node tools/stamp-build.mjs --clear, then node tools/build-demo.mjs.`); process.exit(1); }
    console.log(`index.html is in its committed form: build ${build}, hash placeholder "unstamped"`);
    return;
  }
  if (argv.includes('--clear')) {
    if (committed !== html) fs.writeFileSync(INDEX, committed);
    console.log(`index.html cleared to its committed form: build ${build}, hash placeholder "unstamped". Run node tools/build-demo.mjs next.`);
    return;
  }
  const want = stamp(html, build);
  if (want !== html) fs.writeFileSync(INDEX, want);
  console.log(`index.html stamped for this run: build ${build}, SHA-256 ${verify(want).stamped}. Do not commit the stamped file; node tools/stamp-build.mjs --clear puts the committed form back.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error('FAIL ' + error.message); process.exit(1); }
}
