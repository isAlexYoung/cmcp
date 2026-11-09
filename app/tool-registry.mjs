// The one tool catalog behind every channel (Windows web /mcp, SSH workers, Mac manager):
// built-in groups switched on for this computer plus enabled tools from mcp-tools. It answers
// the JSON-RPC that the cloud connector forwards, and emits 'changed' with a new revision
// whenever the visible list changes, so the channels can tell the connector to refresh.
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {GROUPS,groupOf,toolsRoot,readSettings,scanTools,fingerprint,exposedName,ensureToolsFolder,refreshFile,approvalKey,defaultSecretStore} from './mcp-tools.mjs';
import {ProxyServer} from './mcp-proxy.mjs';

const PROTOCOLS=['2024-11-05','2025-03-26','2025-06-18','2025-11-25'];
const sha=value=>createHash('sha256').update(value).digest('hex');
// Third-party schemas may name any JSON Schema dialect; the connector accepts 2020-12 only,
// and the constraints themselves are shared, so the dialect hint is dropped.
function plainSchema(schema){if(!schema||typeof schema!=='object')return schema;const copy=structuredClone(schema);delete copy.$schema;return copy;}
const text=(message,isError=true)=>({...isError?{isError:true}:{},content:[{type:'text',text:message}]});

export function createToolRegistry({stateDir,providers=[],instructions={},serverName,version,platform=process.platform,env=process.env,secrets=defaultSecretStore(platform),root=toolsRoot(stateDir,platform,env),watch=true,makeProxy=options=>new ProxyServer(options),log=()=>{}}){
  const events=new EventEmitter();events.setMaxListeners(64);
  const proxies=new Map();let view=null,stamp=null,timer=null,watchers=[],active=0,closed=false,warming=new Set();
  try{ensureToolsFolder(root);}catch(error){log('mcp-tools folder unavailable: '+error.message);}
  const builtinNames=new Map();for(const provider of providers)for(const d of provider.definitions)builtinNames.set(d.name,provider);

  function proxyFor(tool,settings){
    let proxy=proxies.get(tool.id);
    if(proxy&&(proxy.hash!==tool.hash||proxy.idleMs!==settings.idleMinutes*60000)){proxies.delete(tool.id);proxy.close().catch(()=>{});proxy=null;}
    if(!proxy){proxy=makeProxy({id:tool.id,manifest:tool.manifest,hash:tool.hash,dir:tool.dir,stateDir,platform,env,secrets,idleMs:settings.idleMinutes*60000,onToolsChanged:()=>check(true)});proxies.set(tool.id,proxy);}
    return proxy;
  }
  // Fill the cache of an enabled tool in the background; the list never waits for a process.
  function warm(proxy){
    if(warming.has(proxy.id)||closed)return;warming.add(proxy.id);
    proxy.refresh().then(()=>check(true),error=>log('['+proxy.id+'] '+error.message)).finally(()=>warming.delete(proxy.id));
  }
  function build(){
    const settings=readSettings(stateDir),groups=new Set(['system',...GROUPS.filter(g=>settings.groups[g])]);
    const tools=[],routes=new Map(),custom=[];
    for(const [name,provider] of builtinNames){
      if(!groups.has(groupOf(name)))continue;
      const d=provider.definitions.find(x=>x.name===name);tools.push(d);routes.set(name,{provider});
    }
    const scanned=scanTools(root,{platform});
    for(const tool of scanned){
      const enabled=settings.tools[tool.id]===true,approved=tool.manifest&&settings.acknowledged[tool.id]===approvalKey(tool.manifest);
      const entry={id:tool.id,name:tool.manifest?.name||tool.id,enabled,approved:!!approved,errors:tool.errors,warnings:tool.warnings,count:0};
      custom.push(entry);
      if(!tool.manifest){for(const p of [proxies.get(tool.id)])if(p){proxies.delete(tool.id);p.close().catch(()=>{});}continue;}
      if(!enabled||!approved){const p=proxies.get(tool.id);if(p){proxies.delete(tool.id);p.close().catch(()=>{});}continue;}
      const proxy=proxyFor(tool,settings),listed=proxy.cachedTools();
      Object.assign(entry,proxy.status());
      if(!listed){if(proxy.state!=='error'&&proxy.state!=='runtime-missing'&&!proxy.tripped())warm(proxy);entry.state=entry.state==='stopped'?'loading':entry.state;continue;}
      const include=tool.manifest.tools?.include,exclude=new Set(tool.manifest.tools?.exclude||[]),rewrite=tool.manifest.tools?.descriptions||{};
      for(const upstream of listed){
        if(!upstream||typeof upstream.name!=='string'||(include&&!include.includes(upstream.name))||exclude.has(upstream.name))continue;
        const name=exposedName(tool.id,upstream.name);
        if(routes.has(name)){entry.errors=[...entry.errors,'name collision: '+name];continue;}
        const description=[rewrite[upstream.name]||upstream.description||upstream.name,tool.manifest.instructions].filter(Boolean).join(' ').slice(0,2048);
        tools.push({...upstream,name,description:'['+tool.manifest.name+'] '+description,inputSchema:plainSchema(upstream.inputSchema)||{type:'object'},...upstream.outputSchema?{outputSchema:plainSchema(upstream.outputSchema)}:{}});
        routes.set(name,{proxy,upstream:upstream.name});entry.count++;
      }
    }
    // Retire processes of tools whose folder disappeared.
    for(const [id,p] of proxies)if(!scanned.some(t=>t.id===id&&t.manifest)){proxies.delete(id);p.close().catch(()=>{});}
    const parts=[instructions.base||''];
    if(groups.has('blender')&&instructions.blender)parts.push(instructions.blender);
    if(custom.some(t=>t.enabled&&t.count))parts.push('Tools named <tool>__<name> are third-party MCP servers the user installed on this local computer; they run with the user\'s local account.');
    const enabledGroups=[...groups];
    const revision=sha(JSON.stringify([tools,parts,enabledGroups]));
    return {tools,routes,instructions:parts.filter(Boolean).join(' '),groups:enabledGroups,revision,custom,settings};
  }
  // Recompute when anything that decides the list changed; emit only if the result changed.
  function check(force=false){
    if(closed)return view;
    const next=fingerprint(stateDir,root);
    if(!force&&view&&next===stamp)return view;
    const previous=view?.revision;stamp=next;view=build();
    if(previous&&previous!==view.revision)events.emit('changed',view.revision);
    return view;
  }
  // Manual refresh: forget cached tool lists and read every enabled tool again.
  let refreshStamp=null;
  function refreshRequested(){try{const s=fs.statSync(refreshFile(stateDir));const value=s.mtimeMs+':'+s.size;if(refreshStamp!==null&&value!==refreshStamp){refreshStamp=value;return true;}refreshStamp=value;}catch{}return false;}
  function onFiles(){
    clearTimeout(timer);timer=setTimeout(()=>{
      // A manual refresh also gives tools suspended after repeated failures another chance.
      if(refreshRequested())for(const p of proxies.values()){p.failures=[];warm(p);}
      check();
    },300);timer.unref?.();
  }
  refreshRequested();check(true);
  if(watch){
    for(const [target,recursive] of [[stateDir,false],[root,true]]){
      try{watchers.push(fs.watch(target,{recursive,persistent:false},onFiles));}
      catch{try{watchers.push(fs.watch(target,{persistent:false},onFiles));}catch{}}
    }
    for(const w of watchers)w.on('error',()=>{});
  }
  async function call(name,args){
    const current=check(),route=current.routes.get(name);
    if(!route)return null;
    if(route.provider)return route.provider.call(name,args);
    return route.proxy.call(route.upstream,args);
  }
  async function forward(msg){
    const id=msg?.id??null,error=(code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
    if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||(id!==null&&typeof id!=='string'&&typeof id!=='number'))return error(-32600,'Invalid JSON-RPC request');
    if(!Object.hasOwn(msg,'id'))return null;
    let result;
    if(msg.method==='initialize'){
      const current=check();
      result={protocolVersion:PROTOCOLS.includes(msg.params?.protocolVersion)?msg.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:serverName,version},instructions:current.instructions};
    } else if(msg.method==='ping')result={};
    else if(msg.method==='tools/list'){const current=check();result={tools:current.tools,_meta:{'cmcp/catalog':{schema:1,revision:current.revision,groups:current.groups}}};}
    else if(msg.method==='tools/call'){
      const p=msg.params;
      if(!p||typeof p.name!=='string'||(p.arguments!==undefined&&(!p.arguments||typeof p.arguments!=='object'||Array.isArray(p.arguments))))return error(-32602,'Invalid tool call');
      if(!check().routes.has(p.name))return error(-32602,builtinNames.has(p.name)?'Tool '+p.name+' is turned off in CMCP on this computer':'Unknown tool: '+p.name);
      if(active>=16)return error(-32000,'Too many active requests');
      active++;
      try{result=await call(p.name,p.arguments??{});}
      catch(e){result=text(e.message||'Local tool failed; check the operation status before retrying.');}
      finally{active--;}
    } else return error(-32601,'Method not found');
    return {jsonrpc:'2.0',id,result};
  }
  return {
    forward,
    list:()=>check(),
    revision:()=>check().revision,
    instructions:()=>check().instructions,
    call:async(name,args)=>{const r=await call(name,args);return r??text('Unknown tool: '+name);},
    has:name=>check().routes.has(name),
    on:(event,fn)=>{events.on(event,fn);return ()=>events.off(event,fn);},
    refresh(){for(const p of proxies.values()){p.failures=[];warm(p);}return check(true);},
    custom:()=>check().custom,
    async close(){closed=true;clearTimeout(timer);for(const w of watchers)try{w.close();}catch{};await Promise.allSettled([...proxies.values()].map(p=>p.close()));proxies.clear();},
  };
}
