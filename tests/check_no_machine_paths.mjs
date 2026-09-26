import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
const forbidden = new RegExp(`(?:file:\\/\\/)?\\/(?:${['Users','home','private/var','tmp'].join('|')})\\/[^\\s"'<>]*`, '');
const ignored = new Set(['.git','node_modules']);
const matches=[];
function visit(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(ignored.has(entry.name))continue;
    const file=path.join(dir,entry.name);
    if(entry.isDirectory()){visit(file);continue;}
    let data;try{data=fs.readFileSync(file);}catch{continue;}
    if(data.includes(0))continue;
    const content=data.toString('utf8');
    if(forbidden.test(content))matches.push(path.relative(ROOT,file));
  }
}
visit(ROOT);
if(matches.length){console.error('Machine-specific absolute paths found:',...matches);process.exitCode=1;}
else console.log('No machine-specific absolute paths found.');
