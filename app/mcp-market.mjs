// The tool market: presets shipped with CMCP (app/mcp-presets/<id>.json). A preset is a reviewed
// cmcp-tool.json with a pinned version plus texts for the Settings market page. CMCP carries no
// third-party code: npx/uvx fetch the pinned package from its official registry on first start.
// Installing writes mcp-tools/<id>; nothing is ever updated without the user's confirmation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ID,RESERVED,toolsRoot,ensureToolsFolder,parseManifest,approvalKey,describeTool,readSettings,updateSettings,resolveLaunch,RuntimeMissing,runtimeOf,detectApp,atomicWrite} from './mcp-tools.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_DIR=path.join(here,'mcp-presets');
export const CATEGORIES=['3d','browser','web','memory','developer','design','data','other'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const bilingual=(value,max)=>value&&typeof value==='object'&&text(value.zh,max)&&text(value.en,max);
export const cmcpVersion=()=>JSON.parse(fs.readFileSync(path.join(here,'package.json'),'utf8')).version;

// Numeric comparison of dotted versions; works for semver (1.12.0) and calendar versions (2026.10.28).
export function compareVersions(a,b){
  const parts=v=>String(v).split(/[^0-9]+/).filter(Boolean).map(Number);
  const x=parts(a),y=parts(b);
  for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return Math.sign(d);}
  return 0;
}

// What package and exact version a preset runs. Presets must run a published package pinned to
// one version, so a preset is the same code for every user until its file changes.
export function pinnedPackage(manifest){
  const args=manifest.args||[];
  if(manifest.transport!=='stdio')return {error:'presets run local stdio servers'};
  if(manifest.command==='npx'){
    for(const arg of args){if(arg.startsWith('-'))continue;const m=/^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(arg);return m?{registry:'npm',name:m[1],version:m[2]}:{error:'npx must name package@exact.version first'};}
    return {error:'npx without a package'};
  }
  if(manifest.command==='uvx'){
    const from=args.indexOf('--from'),spec=from>=0?args[from+1]:args.find(a=>!a.startsWith('-')&&!/^\d/.test(a)&&args[args.indexOf(a)-1]!=='--python');
    const m=/^([A-Za-z0-9][\w.-]*)==([\w.]+)$/.exec(spec||'');return m?{registry:'pypi',name:m[1],version:m[2]}:{error:'uvx must name package==exact.version'};
  }
  if(manifest.command==='docker'){
    const image=args.find((a,i)=>i>0&&!a.startsWith('-')&&args[i-1]!=='-e'&&args[i-1]!=='--network'&&/[:@]/.test(a));
    const m=/^([\w./-]+)(?:@(sha256:[a-f0-9]{64})|:([\w.-]+))$/.exec(image||'');
    if(!m||m[3]==='latest')return {error:'docker must name image:tag (not latest) or image@sha256'};
    return {registry:'docker',name:m[1],version:m[2]||m[3]};
  }
  return {error:'presets run npx, uvx or docker packages'};
}

export function validatePreset(preset,{file,platform='win32'}={}){
  const errors=[];
  if(!preset||typeof preset!=='object'||Array.isArray(preset))return ['preset must be a JSON object'];
  if(preset.schema!==1)errors.push('schema must be 1');
  if(typeof preset.id!=='string'||!ID.test(preset.id)||RESERVED.has(preset.id)||preset.id.includes('__'))errors.push('id must match '+ID+' and not be reserved');
  if(file&&path.basename(file,'.json')!==preset.id)errors.push('file name must be <id>.json');
  if(!bilingual(preset.title,60))errors.push('title needs zh and en, at most 60 characters');
  if(!bilingual(preset.summary,200))errors.push('summary needs zh and en, at most 200 characters');
  if(!CATEGORIES.includes(preset.category))errors.push('category must be one of '+CATEGORIES.join(', '));
  if(preset.minCmcp!==undefined&&!/^\d+\.\d+\.\d+$/.test(preset.minCmcp))errors.push('minCmcp must be a version');
  if(preset.detect!==undefined&&(!Array.isArray(preset.detect)||preset.detect.some(d=>!['blender','chrome'].includes(d))))errors.push('detect may list blender, chrome');
  const m=preset.manifest;
  if(!m||typeof m!=='object'){errors.push('manifest is required');return errors;}
  const parsed=parseManifest(JSON.stringify(m),{id:preset.id,platform});
  errors.push(...parsed.errors.filter(e=>!/not available on this computer/.test(e)).map(e=>'manifest: '+e));
  for(const w of parsed.warnings)if(['UNPINNED','SECRET_IN_MANIFEST'].includes(w.code))errors.push('manifest: '+w.code+' '+(w.field||''));
  if(!text(m.version,64))errors.push('manifest.version is required');
  if(!text(m.license,64))errors.push('manifest.license is required');
  if(!(typeof m.homepage==='string'&&/^https:\/\//.test(m.homepage)))errors.push('manifest.homepage must be an https link');
  if(!Array.isArray(m.capabilities)||!m.capabilities.length)errors.push('manifest.capabilities must say what the tool can do');
  const pinned=pinnedPackage(m);
  if(pinned.error)errors.push('pinned version: '+pinned.error);
  else if(m.version&&compareVersions(pinned.version,m.version)!==0&&pinned.registry!=='docker')errors.push('manifest.version '+m.version+' differs from the pinned '+pinned.version);
  if(m.preset!==undefined)errors.push('manifest.preset is written by CMCP; leave it out');
  return errors;
}

export function readPresets(dir=PRESETS_DIR,{platform=process.platform}={}){
  let names=[];try{names=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort();}catch{return [];}
  return names.map(name=>{
    const file=path.join(dir,name);let preset=null,errors;
    try{preset=JSON.parse(fs.readFileSync(file,'utf8'));errors=validatePreset(preset,{file,platform});}catch(error){errors=['not valid JSON: '+error.message];}
    return {file,preset,errors};
  });
}

const markerFile=(root,id)=>path.join(root,id,'.cmcp-preset.json');
function readMarker(root,id){try{const m=JSON.parse(fs.readFileSync(markerFile(root,id),'utf8'));return m.schema===1&&m.id===id?m:null;}catch{return null;}}
const manifestText=preset=>JSON.stringify({...preset.manifest,preset:{id:preset.id,version:preset.manifest.version}},null,2)+'\n';

function requirementState(preset,{platform,env,dirs}){
  const m=preset.manifest,needs=[];
  try{resolveLaunch(m.command,[],{platform,env,...dirs?{dirs}:{}});needs.push({kind:'runtime',name:runtimeOf(m.command),ok:true});}
  catch(error){needs.push({kind:'runtime',name:error.runtime||runtimeOf(m.command),ok:false,hint:error instanceof RuntimeMissing?error.hint:{zh:error.message,en:error.message}});}
  for(const app of preset.detect||[]){
    const found=detectApp(app,platform,env);
    needs.push({kind:'app',name:app,ok:!!found,path:found||null,hint:found?null:{zh:'需要先安装 '+({blender:'Blender',chrome:'Google Chrome'}[app]||app),en:'Install '+({blender:'Blender',chrome:'Google Chrome'}[app]||app)+' first'}});
  }
  return needs;
}

// One row per preset for the market page.
export function marketView(stateDir,{platform=process.platform,env=process.env,dir=PRESETS_DIR,root=toolsRoot(stateDir,platform,env),dirs,version=cmcpVersion()}={}){
  try{ensureToolsFolder(root);}catch{}
  const settings=readSettings(stateDir);
  return readPresets(dir,{platform}).filter(p=>p.preset&&!p.errors.length).map(({preset})=>{
    const m=preset.manifest,marker=readMarker(root,preset.id),folder=path.join(root,preset.id);
    let installed=null;
    if(marker){
      let current='';try{current=fs.readFileSync(path.join(folder,'cmcp-tool.json'),'utf8');}catch{}
      installed={version:marker.version,modified:!!current&&sha(current)!==marker.sha256,enabled:settings.tools[preset.id]===true};
    }
    const occupied=!marker&&fs.existsSync(folder);
    const tooNew=preset.minCmcp&&compareVersions(version,preset.minCmcp)<0;
    const unsupported=m.platforms&&!m.platforms.includes(platform);
    const update=installed&&compareVersions(m.version,installed.version)>0?m.version:null;
    const requires=requirementState(preset,{platform,env,dirs});
    return {id:preset.id,title:preset.title,summary:preset.summary,category:preset.category,version:m.version,license:m.license,homepage:m.homepage,
      capabilities:m.capabilities,describe:describeTool(m),requires,installed,update,
      blocked:tooNew?{zh:'需要 CMCP '+preset.minCmcp+' 或更新版本',en:'Needs CMCP '+preset.minCmcp+' or later'}:unsupported?{zh:'不支持这台电脑的系统',en:'Not available on this system'}:occupied?{zh:'mcp-tools 里已有同名文件夹 '+preset.id,en:'mcp-tools already has a folder named '+preset.id}:null};
  });
}

function presetById(id,dir){
  const found=readPresets(dir).find(p=>p.preset?.id===id);
  if(!found)throw Error('Unknown preset');
  if(found.errors.length)throw Error('Preset is invalid: '+found.errors.join('; '));
  return found.preset;
}
// Install: the tool folder with the pinned manifest. The tool stays off until the user turns it on.
export function installPreset(stateDir,id,{dir=PRESETS_DIR,root=toolsRoot(stateDir),version=cmcpVersion()}={}){
  const preset=presetById(id,dir);
  if(preset.minCmcp&&compareVersions(version,preset.minCmcp)<0)throw Error('需要 CMCP '+preset.minCmcp+' 或更新版本');
  const folder=path.join(root,id);
  if(fs.existsSync(folder))throw Error(readMarker(root,id)?'已经安装':'mcp-tools 里已有同名文件夹：'+id);
  ensureToolsFolder(root);fs.mkdirSync(folder,{recursive:true});
  const content=manifestText(preset);
  atomicWrite(path.join(folder,'cmcp-tool.json'),content,0o644);
  atomicWrite(markerFile(root,id),JSON.stringify({schema:1,id,version:preset.manifest.version,sha256:sha(content)},null,2)+'\n',0o644);
  return {installed:id,version:preset.manifest.version};
}
// Update only after the user confirmed the new version. A tool that was on stays on: that
// confirmation is the new approval of what this version runs. Never called automatically.
export function updatePreset(stateDir,id,{dir=PRESETS_DIR,root=toolsRoot(stateDir),version=cmcpVersion(),confirmed=false}={}){
  if(confirmed!==true)throw Error('An update needs the user\'s confirmation');
  const preset=presetById(id,dir),marker=readMarker(root,id);
  if(!marker)throw Error('这个工具不是从市场安装的');
  if(preset.minCmcp&&compareVersions(version,preset.minCmcp)<0)throw Error('需要 CMCP '+preset.minCmcp+' 或更新版本');
  if(compareVersions(preset.manifest.version,marker.version)<=0)throw Error('已经是最新版本');
  const content=manifestText(preset);
  atomicWrite(path.join(root,id,'cmcp-tool.json'),content,0o644);
  atomicWrite(markerFile(root,id),JSON.stringify({schema:1,id,version:preset.manifest.version,sha256:sha(content)},null,2)+'\n',0o644);
  updateSettings(stateDir,s=>{if(s.tools[id]===true)s.acknowledged[id]=approvalKey(parseManifest(content,{id}).manifest);});
  return {updated:id,from:marker.version,to:preset.manifest.version};
}

// CI and contributors: every preset valid, pinned, and (online) published on its registry.
export async function checkPresets({dir=PRESETS_DIR,online=false,fetchImpl=fetch}={}){
  const results=[];const ids=new Set();
  for(const {file,preset,errors} of readPresets(dir,{platform:'win32'})){
    const problems=[...errors];
    if(preset?.id){if(ids.has(preset.id))problems.push('duplicate id');ids.add(preset.id);}
    if(online&&preset&&!problems.length){
      const pinned=pinnedPackage(preset.manifest);
      const url=pinned.registry==='npm'?'https://registry.npmjs.org/'+pinned.name.replace('/','%2f')+'/'+pinned.version:pinned.registry==='pypi'?'https://pypi.org/pypi/'+pinned.name+'/'+pinned.version+'/json':null;
      if(url){try{const r=await fetchImpl(url,{signal:AbortSignal.timeout(20000)});if(r.status!==200)problems.push(pinned.registry+' has no '+pinned.name+' '+pinned.version+' (HTTP '+r.status+')');}catch(error){problems.push('cannot reach '+pinned.registry+': '+error.message);}}
    }
    results.push({file:path.basename(file),id:preset?.id||null,errors:problems});
  }
  return {ok:results.length>0&&results.every(r=>!r.errors.length),results};
}
