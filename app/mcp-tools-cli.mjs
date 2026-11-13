// Command line for the mcp-tools folder. The Windows settings page runs it with the bundled
// node (one JSON object per run on stdout); `check` is the one-command test from AGENT.md.
//   status  --state DIR
//   set     --state DIR (--group NAME | --tool ID) (--on | --off) | --idle MINUTES | --blender-offer-done
//   apply   --state DIR                    (stdin {"groups":{name:bool},"tools":{id:bool}}: one write)
//   refresh --state DIR
//   import  --state DIR [--apply]          (reads the pasted text on stdin)
//   remove  --state DIR --tool ID
//   check   FOLDER [--call TOOL JSON] [--state DIR]
//   market  --state DIR                    (presets with requirements, installed and newer versions)
//   install --state DIR --preset ID        (writes mcp-tools/ID; the tool stays off)
//   update  --state DIR --preset ID --confirmed   (only after the user confirmed the new version)
//   presets-check [--online]               (CI: every preset valid, pinned, published)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GROUPS,INTERFACE,ID,toolsRoot,readSettings,updateSettings,requestRefresh,scanTools,parseManifest,approvalKey,describeTool,parseImport,installImported,
  ensureToolsFolder,secretNames,toolLogFile,detectBlender,resolveLaunch,exposedName,defaultSecretStore,RuntimeMissing,runtimeOf} from './mcp-tools.mjs';
import {ProxyServer,readToolCache} from './mcp-proxy.mjs';
import {marketView,installPreset,updatePreset,checkPresets} from './mcp-market.mjs';

function options(argv){
  const values={_:[]};
  for(let i=0;i<argv.length;i++){const a=argv[i];if(a.startsWith('--')){const key=a.slice(2);if(['on','off','apply','blender-offer-done','json','confirmed','online'].includes(key))values[key]=true;else values[key]=argv[++i];}else values._.push(a);}
  return values;
}
const stdin=async()=>{const chunks=[];let size=0;for await(const c of process.stdin){size+=c.length;if(size>256*1024)throw Error('粘贴的内容太长');chunks.push(c);}return Buffer.concat(chunks).toString('utf8');};
const stateOf=o=>{if(!o.state)throw Error('--state is required');return path.resolve(o.state);};
function lastLines(file,count=5){try{const text=fs.readFileSync(file,'utf8');return text.trimEnd().split('\n').slice(-count);}catch{return [];}}
function runtimeProblem(m,dir){
  const commands=m.transport==='stdio'?[m.command]:m.start?[m.start.command]:[];
  for(const command of commands){
    try{resolveLaunch(command,[],{dir});}
    catch(error){return error instanceof RuntimeMissing?{runtime:error.runtime,zh:error.message,en:error.hint.en}:{runtime:runtimeOf(command),zh:error.message,en:error.message};}
  }
  return null;
}

export function status(state,{platform=process.platform}={}){
  const root=toolsRoot(state,platform);try{ensureToolsFolder(root);}catch{}
  const settings=readSettings(state);
  const tools=scanTools(root,{platform}).map(tool=>{
    const m=tool.manifest,cached=m?readToolCache(state,tool.id,tool.hash):null;
    const needed=m?[...Object.entries(m.env||{}),...Object.entries(m.headers||{})].filter(([,v])=>v&&typeof v==='object').map(([k])=>(m.env?.[k]?'env:':'header:')+k):[];
    const stored=secretNames(state,tool.id);
    return {id:tool.id,name:m?.name||tool.id,description:m?.description||'',version:m?.version||null,homepage:m?.homepage||null,
      enabled:settings.tools[tool.id]===true,approved:!!m&&settings.acknowledged[tool.id]===approvalKey(m),
      errors:tool.errors,warnings:tool.warnings,capabilities:m?.capabilities||[],describe:m?describeTool(m):null,
      missingSecrets:needed.filter(k=>!stored.includes(k)),runtime:m?runtimeProblem(m,tool.dir):null,
      tools:cached?cached.map(t=>exposedName(tool.id,t.name)):null,log:toolLogFile(state,tool.id),recent:lastLines(toolLogFile(state,tool.id),3)};
  });
  return {interface:INTERFACE,root,groups:settings.groups,idleMinutes:settings.idleMinutes,
    blender:{detected:detectBlender(platform),offerDone:settings.blenderOffer.done,enabled:settings.groups.blender},tools};
}
export function set(state,o){
  return updateSettings(state,s=>{
    if(o.group!==undefined){if(!GROUPS.includes(o.group))throw Error('Unknown group');s.groups[o.group]=o.on===true;}
    if(o.tool!==undefined){
      if(!ID.test(o.tool))throw Error('Unknown tool');
      if(o.on){
        // Turning a tool on records that the user saw what this exact command can do.
        const tool=scanTools(toolsRoot(state)).find(t=>t.id===o.tool);
        if(!tool?.manifest)throw Error(tool?tool.errors.join('; '):'Unknown tool');
        s.tools[o.tool]=true;s.acknowledged[o.tool]=approvalKey(tool.manifest);
      } else s.tools[o.tool]=false;
    }
    if(o.idle!==undefined){const n=Number(o.idle);if(!Number.isInteger(n)||n<0||n>1440)throw Error('Idle minutes must be 0-1440');s.idleMinutes=n;}
    if(o['blender-offer-done'])s.blenderOffer.done=true;
  });
}
// Several switches in one write: the settings pages collect quick clicks and save only the last
// state of each switch, so other CMCP processes see one change instead of a burst.
export function applySwitches(state,{groups={},tools={}}={}){
  if(!groups||typeof groups!=='object'||Array.isArray(groups)||!tools||typeof tools!=='object'||Array.isArray(tools))throw Error('Invalid switches');
  for(const [name,on] of Object.entries(groups))if(!GROUPS.includes(name)||typeof on!=='boolean')throw Error('Unknown group');
  for(const [id,on] of Object.entries(tools))if(!ID.test(id)||typeof on!=='boolean')throw Error('Unknown tool');
  const scanned=Object.values(tools).some(Boolean)?scanTools(toolsRoot(state)):[];
  return updateSettings(state,s=>{
    for(const [name,on] of Object.entries(groups))s.groups[name]=on;
    for(const [id,on] of Object.entries(tools)){
      if(!on){s.tools[id]=false;continue;}
      const tool=scanned.find(t=>t.id===id);
      if(!tool?.manifest)throw Error(tool?tool.errors.join('; '):'Unknown tool');
      s.tools[id]=true;s.acknowledged[id]=approvalKey(tool.manifest);
    }
  });
}
export async function importText(state,text,{apply=false,secrets=defaultSecretStore()}={}){
  const root=toolsRoot(state);ensureToolsFolder(root);
  const existing=new Set(scanTools(root).map(t=>t.id));for(const name of fs.readdirSync(root))existing.add(name);
  const items=parseImport(text,{existing});
  const view=items.map(i=>({id:i.id,name:i.manifest.name,command:[i.manifest.command||i.manifest.url,...i.manifest.args||[]].join(' '),secrets:Object.keys(i.secrets),errors:i.errors,warnings:i.warnings,describe:describeTool(i.manifest)}));
  if(!apply)return {items:view};
  if(items.some(i=>i.errors.length))throw Error(items.flatMap(i=>i.errors).join('; '));
  const installed=[];for(const item of items)installed.push(await installImported(root,state,item,{secrets}));
  return {items:view,installed};
}
export async function remove(state,id,{waitMs=15000}={}){
  if(!ID.test(id))throw Error('Unknown tool');
  const root=toolsRoot(state),dir=path.join(root,id);if(!fs.existsSync(dir))throw Error('Unknown tool');
  // Switch it off first: every CMCP process then stops the tool, and Windows releases its folder.
  updateSettings(state,s=>{delete s.tools[id];delete s.acknowledged[id];});requestRefresh(state);
  // Kept inside mcp-tools (folders starting with "." are ignored) so nothing is lost by mistake.
  const target=path.join(root,'.removed-'+id+'-'+new Date().toISOString().replace(/[:.]/g,'-'));
  for(const end=Date.now()+waitMs;;){
    try{fs.renameSync(dir,target);break;}
    catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||Date.now()>=end)throw Error('这个工具仍在运行，文件夹被占用；请稍后再删除（'+error.code+'）');await new Promise(r=>setTimeout(r,250));}
  }
  return {removed:id,keptAt:target};
}
// Validate, start once, list the names Claude will see, optionally call one tool, stop.
export async function check(folder,{call,args,state,secrets=defaultSecretStore()}={}){
  const dir=path.resolve(folder),id=path.basename(dir),file=path.join(dir,'cmcp-tool.json');
  const text=fs.readFileSync(file,'utf8'),parsed=parseManifest(text,{id,dir});
  const report={id,errors:parsed.errors,warnings:parsed.warnings,tools:[]};
  if(parsed.errors.length)return {ok:false,...report};
  const stateDir=state?path.resolve(state):fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-tool-check-'));
  const proxy=new ProxyServer({id,manifest:parsed.manifest,hash:'check',dir,stateDir,secrets,idleMs:0});
  try{
    const listed=await proxy.refresh();
    report.tools=listed.map(t=>({name:exposedName(id,t.name),upstream:t.name,description:(t.description||'').slice(0,200)}));
    if(call){const r=await proxy.call(call,args?JSON.parse(args):{});report.call={tool:call,isError:r.isError===true,content:r.content};}
    return {ok:!report.call?.isError,...report};
  }catch(error){return {ok:false,...report,errors:[error.message],...error.hint?{hint:error.hint}:{}};}
  finally{await proxy.close();if(!state)fs.rmSync(stateDir,{recursive:true,force:true});}
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...rest]=process.argv.slice(2),o=options(rest);
  const print=value=>process.stdout.write(JSON.stringify(value)+'\n');
  try{
    if(command==='status')print(status(stateOf(o)));
    else if(command==='set'){set(stateOf(o),o);print({saved:true});}
    else if(command==='apply'){const s=applySwitches(stateOf(o),JSON.parse(await stdin()||'{}'));print({saved:true,groups:s.groups,tools:s.tools});}
    else if(command==='refresh'){requestRefresh(stateOf(o));print({refreshed:true});}
    else if(command==='import')print(await importText(stateOf(o),await stdin(),{apply:o.apply===true}));
    else if(command==='remove')print(await remove(stateOf(o),o.tool));
    else if(command==='market')print({presets:marketView(stateOf(o))});
    else if(command==='install'){const r=installPreset(stateOf(o),o.preset);requestRefresh(stateOf(o));print(r);}
    else if(command==='update'){const r=updatePreset(stateOf(o),o.preset,{confirmed:o.confirmed===true});requestRefresh(stateOf(o));print(r);}
    else if(command==='presets-check'){const r=await checkPresets({online:o.online===true});
      for(const item of r.results)process.stdout.write((item.errors.length?'FAIL ':'OK   ')+item.file+(item.errors.length?': '+item.errors.join('; '):'')+'\n');
      process.stdout.write(r.ok?'OK '+r.results.length+' presets\n':'FAILED\n');process.exitCode=r.ok?0:1;}
    else if(command==='check'){
      if(!o._[0])throw Error('usage: check FOLDER [--call TOOL JSON]');
      const result=await check(o._[0],{call:o.call,args:o._[1],state:o.state});
      if(o.json)print(result);
      else{
        for(const e of result.errors)process.stdout.write('ERROR '+e+'\n');
        for(const w of result.warnings)process.stdout.write('WARNING '+w.code+' '+(w.field||'')+'\n');
        if(result.hint)process.stdout.write('HINT '+result.hint.en+'\n');
        for(const t of result.tools)process.stdout.write('TOOL '+t.name+(t.name.endsWith(t.upstream)?'':' ('+t.upstream+')')+' - '+t.description+'\n');
        if(result.call)process.stdout.write('CALL '+result.call.tool+(result.call.isError?' failed: ':' ok: ')+JSON.stringify(result.call.content).slice(0,2000)+'\n');
        process.stdout.write(result.ok?'OK '+result.tools.length+' tools\n':'FAILED\n');
      }
      process.exitCode=result.ok?0:1;
    }
    else throw Error('unknown command');
  }catch(error){print({error:error.message});process.exitCode=1;}
}
