// The tool market: preset rules (pinned, reviewed fields), requirement checks, install and the
// confirmed update, the {data}/{tool} placeholders, and the presets shipped in app/mcp-presets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePreset,pinnedPackage,compareVersions,marketView,installPreset,updatePreset,checkPresets,readPresets,PRESETS_DIR} from '../mcp-market.mjs';
import {readSettings,updateSettings,approvalKey,parseManifest,toolsRoot} from '../mcp-tools.mjs';
import {ProxyServer} from '../mcp-proxy.mjs';

const fixture=fileURLToPath(new URL('./fixtures/mcp-tool-fixture.mjs',import.meta.url));
function folders(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-market-'))),state=path.join(base,'user'),root=path.join(base,'mcp-tools'),presets=path.join(base,'presets');
  fs.mkdirSync(state);fs.mkdirSync(presets);t.after(()=>{for(let i=0;i<20;i++)try{fs.rmSync(base,{recursive:true,force:true});return;}catch{}});
  return {base,state,root,presets};
}
const preset=(over={},manifest={})=>({schema:1,id:'demo',category:'developer',title:{zh:'演示',en:'Demo'},summary:{zh:'演示工具',en:'A demo tool'},
  manifest:{schema:1,name:'Demo',description:'Demo server',homepage:'https://example.com/demo',license:'MIT',version:'1.2.3',transport:'stdio',command:'npx',args:['-y','demo-mcp@1.2.3'],capabilities:['files'],...manifest},...over});
const write=(dir,p)=>fs.writeFileSync(path.join(dir,p.id+'.json'),JSON.stringify(p));

test('every preset shipped with CMCP is valid and pinned to one published version',async()=>{
  const shipped=readPresets(PRESETS_DIR);assert.ok(shipped.length>=5);
  for(const {file,errors} of shipped)assert.deepEqual(errors,[],file);
  const result=await checkPresets();assert.equal(result.ok,true,JSON.stringify(result.results));
  assert.ok(shipped.some(p=>p.preset.id==='blender_mcp'&&p.preset.detect.includes('blender')));
});

test('preset rules: exact versions, reviewed fields, no CMCP-written fields, no secrets',()=>{
  assert.deepEqual(validatePreset(preset()),[]);
  assert.deepEqual(pinnedPackage(preset().manifest),{registry:'npm',name:'demo-mcp',version:'1.2.3'});
  assert.deepEqual(pinnedPackage({transport:'stdio',command:'npx',args:['-y','@scope/pkg@0.0.84','--browser','chrome']}),{registry:'npm',name:'@scope/pkg',version:'0.0.84'});
  assert.deepEqual(pinnedPackage({transport:'stdio',command:'uvx',args:['--python','3.11','--from','mcp-for-blender==2.2.5','blender']}),{registry:'pypi',name:'mcp-for-blender',version:'2.2.5'});
  assert.deepEqual(pinnedPackage({transport:'stdio',command:'docker',args:['run','-i','--rm','ghcr.io/x/y:1.4']}),{registry:'docker',name:'ghcr.io/x/y',version:'1.4'});
  for(const [manifest,pattern] of [[{args:['demo-mcp@latest']},/pinned|UNPINNED/],[{args:['demo-mcp']},/pinned|UNPINNED/],[{args:['-y','demo-mcp@^1.2.0']},/pinned/],
    [{command:'docker',args:['run','image:latest']},/docker/],[{command:'node',args:['server.mjs']},/npx, uvx or docker/],[{version:'1.2.4'},/differs from the pinned/],
    [{license:undefined},/license/],[{homepage:'http://example.com'},/homepage/],[{capabilities:[]},/capabilities/],[{env:{API_KEY:'sk-live-1234567890'}},/SECRET_IN_MANIFEST/],[{preset:{id:'demo'}},/written by CMCP/]])
    assert.ok(validatePreset(preset({},manifest)).some(e=>pattern.test(e)),JSON.stringify(manifest)+' '+validatePreset(preset({},manifest)));
  assert.ok(validatePreset(preset({id:'blender'})).some(e=>/reserved/.test(e)));
  assert.ok(validatePreset(preset({title:{zh:'只有中文'}})).some(e=>/title/.test(e)));
  assert.ok(validatePreset(preset({detect:['photoshop']})).some(e=>/detect/.test(e)));
  assert.ok(validatePreset(preset(),{file:'/x/other.json'}).some(e=>/file name/.test(e)));
});

test('versions compare numerically for semver and calendar versions',()=>{
  assert.equal(compareVersions('1.12.0','1.9.9'),1);assert.equal(compareVersions('2026.10.28','2026.11.4'),-1);assert.equal(compareVersions('0.0.84','0.0.84'),0);assert.equal(compareVersions('2.2','2.2.0'),0);
});

test('online check finds a version the registry does not have',async t=>{
  const f=folders(t);write(f.presets,preset());
  const seen=[];const result=await checkPresets({dir:f.presets,online:true,fetchImpl:async url=>{seen.push(url);return {status:404};}});
  assert.equal(result.ok,false);assert.match(result.results[0].errors[0],/npm has no demo-mcp 1.2.3/);assert.deepEqual(seen,['https://registry.npmjs.org/demo-mcp/1.2.3']);
});

test('the market shows requirements, installs a tool that stays off, and never updates on its own',t=>{
  const f=folders(t);const empty=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-no-runtimes-'));t.after(()=>fs.rmSync(empty,{recursive:true,force:true}));
  write(f.presets,preset({detect:['blender']}));
  let [row]=marketView(f.state,{dir:f.presets,root:f.root,dirs:[empty],env:{},platform:'linux'});
  assert.equal(row.id,'demo');assert.equal(row.installed,null);assert.equal(row.update,null);
  assert.deepEqual(row.requires.map(r=>[r.kind,r.name,r.ok]),[['runtime','node',false],['app','blender',false]]);assert.match(row.requires[0].hint.zh,/Node/);
  installPreset(f.state,'demo',{dir:f.presets,root:f.root});
  const written=JSON.parse(fs.readFileSync(path.join(f.root,'demo','cmcp-tool.json'),'utf8'));assert.deepEqual(written.preset,{id:'demo',version:'1.2.3'});
  assert.equal(readSettings(f.state).tools.demo,undefined,'installed tools start off');
  assert.throws(()=>installPreset(f.state,'demo',{dir:f.presets,root:f.root}),/已经安装/);
  // A newer preset arrives with a CMCP update: shown as an update, nothing changes by itself.
  write(f.presets,preset({},{version:'1.3.0',args:['-y','demo-mcp@1.3.0']}));
  [row]=marketView(f.state,{dir:f.presets,root:f.root,env:{},platform:'linux'});
  assert.equal(row.update,'1.3.0');assert.equal(row.installed.version,'1.2.3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'demo','cmcp-tool.json'),'utf8')).version,'1.2.3');
  assert.throws(()=>updatePreset(f.state,'demo',{dir:f.presets,root:f.root}),/confirmation/);
  // The tool was on: the confirmed update keeps it on, approved for the new command.
  updateSettings(f.state,s=>{s.tools.demo=true;s.acknowledged.demo=approvalKey(parseManifest(fs.readFileSync(path.join(f.root,'demo','cmcp-tool.json'),'utf8')).manifest);});
  const result=updatePreset(f.state,'demo',{dir:f.presets,root:f.root,confirmed:true});assert.deepEqual(result,{updated:'demo',from:'1.2.3',to:'1.3.0'});
  const updated=fs.readFileSync(path.join(f.root,'demo','cmcp-tool.json'),'utf8');
  assert.equal(readSettings(f.state).acknowledged.demo,approvalKey(parseManifest(updated).manifest));
  [row]=marketView(f.state,{dir:f.presets,root:f.root,env:{},platform:'linux'});assert.equal(row.update,null);assert.equal(row.installed.modified,false);
  fs.appendFileSync(path.join(f.root,'demo','cmcp-tool.json'),' ');
  [row]=marketView(f.state,{dir:f.presets,root:f.root,env:{},platform:'linux'});assert.equal(row.installed.modified,true,'local edits are shown before an update overwrites them');
});

test('a folder of the same name, a newer CMCP requirement and another system block installing',t=>{
  const f=folders(t);
  write(f.presets,preset());fs.mkdirSync(path.join(f.root,'demo'),{recursive:true});
  assert.match(marketView(f.state,{dir:f.presets,root:f.root,platform:'linux'})[0].blocked.zh,/同名文件夹/);
  assert.throws(()=>installPreset(f.state,'demo',{dir:f.presets,root:f.root}),/同名/);
  write(f.presets,preset({id:'later',minCmcp:'99.0.0'}));
  const later=marketView(f.state,{dir:f.presets,root:f.root,platform:'linux'}).find(p=>p.id==='later');assert.match(later.blocked.zh,/99\.0\.0/);
  assert.throws(()=>installPreset(f.state,'later',{dir:f.presets,root:f.root}),/99\.0\.0/);
  write(f.presets,preset({id:'maconly'},{platforms:['darwin']}));
  assert.match(marketView(f.state,{dir:f.presets,root:f.root,platform:'win32'}).find(p=>p.id==='maconly').blocked.zh,/不支持/);
});

test('{data} gives each tool a private folder and {tool} its own folder',async t=>{
  const f=folders(t),dir=path.join(f.root,'fx');fs.mkdirSync(dir,{recursive:true});
  const manifest={schema:1,name:'Fx',description:'x',transport:'stdio',command:'node',args:[fixture],capabilities:[],env:{STORE:'{data}/memory.jsonl',HOME_OF_TOOL:'{tool}'}};
  const proxy=new ProxyServer({id:'fx',manifest,hash:'h',dir,stateDir:f.state,idleMs:0});
  try{
    assert.equal((await proxy.call('env',{name:'STORE'})).content[0].text,path.join(f.state,'tool-data','fx')+'/memory.jsonl');
    assert.equal((await proxy.call('env',{name:'HOME_OF_TOOL'})).content[0].text,dir);
    assert.ok(fs.statSync(path.join(f.state,'tool-data','fx')).isDirectory());
  }finally{await proxy.close();}
});
