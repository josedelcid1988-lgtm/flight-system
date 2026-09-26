import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = file => path.join(ROOT, file);
const begin = '<!-- FLIGHT REACT ASSETS BEGIN -->';
const end = '<!-- FLIGHT REACT ASSETS END -->';
const scriptTag = '<script id="flight-react-bundle" src="assets/flight-ui.js"></script>';
const built = await build({
  entryPoints: [at('src/react/flight-ui.jsx')], outfile: at('assets/flight-ui.js'),
  bundle: true, minify: true, format: 'iife', target: ['es2020'], write: false,
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none'
});
const bundle = built.outputFiles[0].text;
const clean = html => {
  const start = html.indexOf(begin), finish = html.indexOf(end);
  if (start >= 0 && finish >= start) html = html.slice(0, start) + html.slice(finish + end.length).replace(/^\r?\n/, '');
  html = html.replace(/<script id="flight-react-bundle"[^>]*>[\s\S]*?<\/script>\s*/, '');
  return html;
};
const installRenderer = source => {
  let html = source;
  const existing = html.indexOf('var legacyMarkup=');
  if (existing >= 0) {
    const condition = html.indexOf(";if(view==='home'&&window.FlightReact)", existing);
    const finish = html.indexOf('}paintIcons();', condition);
    if (condition < 0 || finish < 0) throw new Error('Existing React renderer could not be normalized.');
    const rhs = html.slice(existing + 'var legacyMarkup='.length, condition);
    html = html.slice(0, existing) + `$('#main').innerHTML=${rhs};` + html.slice(finish + 1);
  }
  const prefix = "$('#main').innerHTML=";
  const start = html.indexOf(prefix);
  if (start < 0) throw new Error('Flight main renderer was not found.');
  const finish = html.indexOf(';paintIcons();', start);
  if (finish < 0) throw new Error('Flight renderer completion anchor was not found.');
  const rhs = html.slice(start + prefix.length, finish);
  if (!rhs.includes('renderDashboard()')) throw new Error('Expected the Hangar dashboard renderer is missing.');
  const replacement = `var legacyMarkup=${rhs};if(view==='home'&&window.FlightReact){$('#main').innerHTML='<div id="flight-react-island"></div>';window.FlightReact.renderHangar($('#flight-react-island'),state,MES,function(id){selectedId=id;view='order';render({focus:true});window.scrollTo(0,0);});}else{if(window.FlightReact)window.FlightReact.unmount();$('#main').innerHTML=legacyMarkup;}paintIcons();`;
  return html.slice(0, start) + replacement + html.slice(finish + ';paintIcons();'.length);
};
const expectedIndex = () => {
  let html = installRenderer(clean(fs.readFileSync(at('index.html'), 'utf8')));
  if (!html.includes('</head>')) throw new Error('Flight head close tag is missing.');
  html = html.replace('</head>', `${begin}\n<link rel="stylesheet" href="assets/flight-ui-fonts.css">\n<link rel="stylesheet" href="assets/flight-ui.css">\n${end}\n</head>`);
  const bootAnchor = '<script id="sk-identity">';
  if (!html.includes(bootAnchor)) throw new Error('Flight identity script anchor is missing.');
  return html.replace(bootAnchor, `${scriptTag}\n${bootAnchor}`);
};
const check = process.argv.includes('--check');
const wantedIndex = expectedIndex();
const problems = [];
if (fs.readFileSync(at('assets/flight-ui.js'), 'utf8') !== bundle) problems.push('assets/flight-ui.js');
if (fs.readFileSync(at('index.html'), 'utf8') !== wantedIndex) problems.push('index.html');
if (check) {
  try { execFileSync(process.execPath, [at('tools/build-demo.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' }); }
  catch (error) { problems.push('demo.html and generated demo fixtures'); }
  if (problems.length) { console.error('React build artifacts are stale:', problems.join(', ')); process.exitCode = 1; }
  else console.log('React bundle, production integration, and generated demo builds are current.');
} else {
  fs.writeFileSync(at('assets/flight-ui.js'), bundle);
  fs.writeFileSync(at('index.html'), wantedIndex);
  execFileSync(process.execPath, [at('tools/build-demo.mjs')], { cwd: ROOT, stdio: 'inherit' });
  console.log('Built the offline React Hangar for production and refreshed the numbered demo builds.');
}
