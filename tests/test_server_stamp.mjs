// The committed index.html carries the hash placeholder "unstamped". A server started from a checkout stamps the
// page in memory with the release stamp tool, so the page it serves, and every record written there, carries the
// build's SHA-256 and never "unstamped". A file that is already stamped (a release zip) is served as it is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, servedIndex } from '../server/server.mjs';
import { clear, stamp, verify } from '../tools/stamp-build.mjs';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const build = verify(index).build, committed = clear(index, build), released = stamp(committed, build);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flight-stamp-'));
const write = (name, html) => { const file = path.join(dir, name); fs.writeFileSync(file, html); return file; };
const tag = html => (html.match(/<meta name="fs-build-sha256" content="([^"]*)">/) || [])[1];
const servers = [];
try {
  // The helper: a checkout is stamped exactly as a release would be; a stamped file is left alone.
  assert.equal(servedIndex(write('committed.html', committed)), released, 'a checkout is stamped in memory as the release tool would stamp it');
  assert.equal(servedIndex(write('released.html', released)), released, 'a stamped file is served unchanged');

  // The page the server actually serves from a checkout.
  for (const [name, html] of [['committed.html', committed], ['released.html', released]]) {
    const server = createServer({ dbPath: ':memory:', indexPath: write(name, html), quiet: true, setupCode: 'stamp-test-setup-code' });
    servers.push(server);
    const port = await server.listenAsync(0, '127.0.0.1');
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.notEqual(tag(page), 'unstamped', `${name}: the served page never carries the placeholder`);
    assert.equal(tag(page), tag(released), `${name}: the served page carries the build's SHA-256`);
    // The server adds its own context script to the head; without it the page is the stamped file byte for byte.
    assert.equal(page.replace(/<script id="flight-server">[\s\S]*?<\/script>/, ''), released, `${name}: the served page is the stamped file`);
  }
  console.log('server stamp: a checkout serves the release stamp for its build; a stamped release file is served as it is');
} finally {
  for (const server of servers) server.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
}
