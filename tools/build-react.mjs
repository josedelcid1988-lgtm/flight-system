import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

await build({
  entryPoints: ['src/react/flight-ui.jsx'],
  outfile: 'assets/flight-ui.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none'
});

const read = file => fs.readFileSync(file, 'utf8');
const bundle = read('assets/flight-ui.js').replace(/<\/script/gi, '<\\/script');
const fonts = read('assets/flight-ui-fonts.css');
const styles = read('assets/flight-ui.css');
const demoPath = 'demo.html';
const begin = '<!-- FLIGHT REACT ASSETS BEGIN -->';
const end = '<!-- FLIGHT REACT ASSETS END -->';
const scriptTag = '<script id="flight-react-bundle">';
const endScriptTag = '</script>';
const baseRender = "$('#main').innerHTML=(mnvWs?(window.FlightManeuverUI?window.FlightManeuverUI.render(view):''):view==='plan-home'?(typeof renderPlanDashboard==='function'?renderPlanDashboard():''):view==='plan'?renderPlanBoard():view==='plan-kanban'?renderPlanKanban():view==='plan-forecast'?renderPlanForecast():view==='home'?renderDashboard():view==='serials'?renderSerialLog():view==='trace'?renderTrace():view==='trace-report'?renderTraceReport():view==='wis'?renderWILibrary():view==='wi'?renderWIDetail():view==='order'?(state.orders.length?renderOrder():renderNoOrders()):view==='activity'?renderActivity():renderOrders())+footer();paintIcons();";
const reactRender = "var legacyMarkup=(mnvWs?(window.FlightManeuverUI?window.FlightManeuverUI.render(view):''):view==='plan-home'?(typeof renderPlanDashboard==='function'?renderPlanDashboard():''):view==='plan'?renderPlanBoard():view==='plan-kanban'?renderPlanKanban():view==='plan-forecast'?renderPlanForecast():view==='home'?renderDashboard():view==='serials'?renderSerialLog():view==='trace'?renderTrace():view==='trace-report'?renderTraceReport():view==='wis'?renderWILibrary():view==='wi'?renderWIDetail():view==='order'?(state.orders.length?renderOrder():renderNoOrders()):view==='activity'?renderActivity():renderOrders())+footer();if(view==='home'&&window.FlightReact){window.FlightReact.unmount();$('#main').innerHTML='<div id=\"flight-react-island\"></div><div id=\"flight-legacy-home\"></div>';$('#flight-legacy-home').innerHTML=legacyMarkup;window.FlightReact.renderHangar($('#flight-react-island'),state,MES,function(id){selectedId=id;view='order';render({focus:true});window.scrollTo(0,0);});}else{if(window.FlightReact)window.FlightReact.unmount();$('#main').innerHTML=legacyMarkup;}paintIcons();";
const previousReactRender = "var legacyMarkup=(mnvWs?(window.FlightManeuverUI?window.FlightManeuverUI.render(view):''):view==='plan-home'?(typeof renderPlanDashboard==='function'?renderPlanDashboard():''):view==='plan'?renderPlanBoard():view==='plan-kanban'?renderPlanKanban():view==='plan-forecast'?renderPlanForecast():view==='home'?renderDashboard():view==='serials'?renderSerialLog():view==='trace'?renderTrace():view==='trace-report'?renderTraceReport():view==='wis'?renderWILibrary():view==='wi'?renderWIDetail():view==='order'?(state.orders.length?renderOrder():renderNoOrders()):view==='activity'?renderActivity():renderOrders())+footer();if(view==='home'&&window.FlightReact){window.FlightReact.renderHangar($('#main'),state,MES,function(id){selectedId=id;view='order';render({focus:true});window.scrollTo(0,0);});}else{if(window.FlightReact)window.FlightReact.unmount();$('#main').innerHTML=legacyMarkup;}paintIcons();";
const normalizeDemo = source => {
  let html = source;
  const start = html.indexOf(begin), finish = html.indexOf(end);
  if (start >= 0 && finish >= start) html = html.slice(0, start) + html.slice(finish + end.length).replace(/^\r?\n/, '');
  const scriptAt = html.indexOf(scriptTag);
  if (scriptAt >= 0) {
    const scriptEnd = html.indexOf(endScriptTag, scriptAt);
    if (scriptEnd < 0) throw new Error('Demo React bundle script is not closed.');
    html = html.slice(0, scriptAt) + html.slice(scriptEnd + endScriptTag.length).replace(/^\r?\n/, '');
  }
  return html.replace(reactRender, baseRender).replace(previousReactRender, baseRender);
};
const applyReactDemo = source => {
  let html = normalizeDemo(source);
  if (!html.includes(baseRender)) throw new Error('Demo renderer anchor is missing.');
  html = html.replace(baseRender, reactRender);
  const styleBlock = begin + '\n<style id="flight-react-fonts">' + fonts + '</style>\n<style id="flight-react-styles">' + styles + '</style>\n' + end;
  if (!html.includes('</head>')) throw new Error('Demo head close tag is missing.');
  html = html.replace('</head>', styleBlock + '\n</head>');
  const anchor = '<script id="sk-identity">';
  if (!html.includes(anchor)) throw new Error('Demo boot anchor is missing.');
  html = html.replace(anchor, scriptTag + bundle + endScriptTag + '\n' + anchor);
  return html;
};
if (fs.existsSync(demoPath)) {
  const expected = applyReactDemo(read(demoPath));
  if (process.argv.includes('--check')) {
    if (read(demoPath) !== expected) { console.error('demo.html is not current. Run npm run build:react.'); process.exitCode = 1; }
    else console.log('React interface bundle and demo.html are current.');
  } else {
    fs.writeFileSync(demoPath, expected);
    console.log('Built local React bundle and embedded it into demo.html.');
  }
} else {
  if (process.argv.includes('--check')) { console.error('demo.html is missing.'); process.exitCode = 1; }
  else console.log('Built local React interface bundle.');
}
