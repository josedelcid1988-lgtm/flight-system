import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'dist');
fs.mkdirSync(dist,{recursive:true});
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version.split('.')[0];
for(const [name,files] of [
  [`flight-control-v${version}.zip`,['index.html','VERSION.md','assets']],
  [`flight-control-demo-v${version}.zip`,['demo.html','VERSION.md','assets']],
]){
  const archive=path.join(dist,name);
  fs.rmSync(archive,{force:true});
  execFileSync('zip',['-q','-r',archive,...files],{cwd:root});
  execFileSync('unzip',['-tqq',archive]);
  console.log(`Verified ${path.relative(root,archive)}`);
}
