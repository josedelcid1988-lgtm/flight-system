import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const demo = fs.readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const bundle = fs.readFileSync(new URL('../assets/flight-ui.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../assets/flight-ui.css', import.meta.url), 'utf8');
const fonts = fs.readFileSync(new URL('../assets/flight-ui-fonts.css', import.meta.url), 'utf8');

assert.match(index, /href=\"assets\/flight-ui\.css\"/);
assert.match(index, /src=\"assets\/flight-ui\.js\"/);
assert.match(index, /window\.FlightReact\.renderHangar\(/);
assert.match(index, /innerHTML=legacyMarkup/);
assert.doesNotMatch(index, /renderHangar\(\$\('#main'\)/);
assert.match(bundle, /renderHangar/);
assert.match(css, /\.fr-drawer::backdrop/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /prefers-reduced-transparency/);
assert.match(fonts, /@font-face/);
assert.match(demo, /id=\"flight-react-bundle\"/);
assert.match(demo, /href=\"assets\/flight-ui\.css\"/);
assert.match(demo, /window\.FlightReact\.renderHangar\(/);
assert.match(demo, /innerHTML=legacyMarkup/);
assert.doesNotMatch(demo, /renderHangar\(\$\('#main'\)/);
assert.doesNotMatch(index, /<(?:script|link)[^>]+(?:src|href)=\"https?:\/\//i);
for (const file of ['React-MIT.txt', 'React-DOM-MIT.txt', 'Scheduler-MIT.txt', 'Lucide-React-ISC.txt', 'esbuild-MIT.md', 'Playwright-Apache-2.0.txt']) {
  assert.ok(fs.existsSync(new URL('../docs/licenses/' + file, import.meta.url)), 'missing bundled dependency license: ' + file);
}

const build = spawnSync(process.execPath, ['tools/build-react.mjs', '--check'], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stdout + build.stderr);
console.log('React build: 25 checks, all passed');
