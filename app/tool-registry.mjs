// The one tool catalog behind every channel (Windows web /mcp, SSH workers, Mac manager):
// built-in groups switched on for this computer plus enabled tools from mcp-tools. It answers
// the JSON-RPC that the cloud connector forwards, and emits 'changed' with a new revision
// whenever the visible list changes, so the channels can tell the connector to refresh.
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {GROUPS,groupOf,toolsRoot,readSettings,effectiveSwitches,scanTools,fingerprint,exposedName,ensureToolsFolder,refreshFile,approvalKey,defaultSecretStore} from './mcp-tools.mjs';
import {ProxyServer,readToolExtras} from './mcp-proxy.mjs';

const PROTOCOLS=['2024-11-05','2025-03-26','2025-06-18','2025-11-25'];
const sha=value=>createHash('sha256').update(value).digest('hex');
// Third-party schemas may name any JSON Schema dialect; the connector accepts 2020-12 only,
// and the constraints themselves are shared, so the dialect hint is dropped.
function plainSchema(schema){if(!schema||typeof schema!=='object')return schema;const copy=structuredClone(schema);delete copy.$schema;return copy;}
const text=(message,isError=true)=>({...isError?{isError:true}:{},content:[{type:'text',text:message}]});

export function createToolRegistry({stateDir,providers=[],instructions={},serverName,version,roots=[],platform=process.platform,env=process.env,secrets=defaultSecretStore(platform),root=toolsRoot(stateDir,platform,env),watch=true,makeProxy=options=>new ProxyServer(options),log=()=>{}}){
  const events=new EventEmitter();events.setMaxListeners(64);
  const proxies=new Map();let stamp=null,timer=null,watchers=[],active=0,closed=false,warming=new Set();
  try{ensureToolsFolder(root);}catch(error){log('mcp-tools folder unavailable: '+error.message);}
  const builtinNames=new Map();for(const provider of providers)for(const d of provider.definitions)builtinNames.set(d.name,provider);

  function proxyFor(tool,settings){
    let proxy=proxies.get(tool.id);
    if(proxy&&(proxy.hash!==tool.hash||proxy.idleMs!==settings.idleMinutes*60000)){proxies.delete(tool.id);proxy.close().catch(()=>{});proxy=null;}
    if(!proxy){proxy=makeProxy({id:tool.id,manifest:tool.manifest,hash:tool.hash,dir:tool.dir,stateDir,platform,env,secrets,idleMs:settings.idleMinutes*60000,onToolsChanged:()=>check(true),roots});proxies.set(tool.id,proxy);}
    return proxy;
  }
  // Fill the cache of an enabled tool in the background; the list never waits for a process.
  function warm(proxy){
    if(warming.has(proxy.id)||closed)return;warming.add(proxy.id);
    proxy.refresh().then(()=>check(true),error=>log('['+proxy.id+'] '+error.message)).finally(()=>warming.delete(proxy.id));
  }
  // What the files say, shared by every device: the scanned tools and their processes. A tool's
  // process runs when the tool is approved and on for this computer or for any device.
  let base=null;const views=new Map();
  function buildBase(){
    const settings=readSettings(stateDir),scanned=scanTools(root,{platform}),tools=[];
    for(const tool of scanned){
      const approved=!!tool.manifest&&settings.acknowledged[tool.id]===approvalKey(tool.manifest);
      const wanted=settings.tools[tool.id]===true||Object.values(settings.targets).some(o=>o.tools[tool.id]===true);
      const entry={tool,approved,listed:null,proxy:null,state:null};tools.push(entry);
      if(!tool.manifest||!approved||!wanted){const p=proxies.get(tool.id);if(p){proxies.delete(tool.id);p.close().catch(()=>{});}continue;}
      const proxy=proxyFor(tool,settings);entry.proxy=proxy;entry.listed=proxy.cachedTools();
      if(!entry.listed&&proxy.state!=='error'&&proxy.state!=='runtime-missing'&&!proxy.tripped())warm(proxy);
    }
    // Retire processes of tools whose folder disappeared.
    for(const [id,p] of proxies)if(!scanned.some(t=>t.id===id&&t.manifest)){proxies.delete(id);p.close().catch(()=>{});}
    return {settings,tools};
  }
  // The catalog one device sees: its effective switches over the shared base.
  function viewFor(device=''){
    if(views.has(device))return views.get(device);
    const {settings}=base,on=effectiveSwitches(settings,device||null);
    const groups=new Set(['system',...GROUPS.filter(g=>on.groups[g])]);
    const tools=[],routes=new Map(),custom=[],resources=[],resourceRoutes=new Map(),prompts=[],promptRoutes=new Map();
    for(const [name,provider] of builtinNames){
      if(!groups.has(groupOf(name)))continue;
      const d=provider.definitions.find(x=>x.name===name);tools.push(d);routes.set(name,{provider});
    }
    for(const {tool,approved,listed,proxy} of base.tools){
      const enabled=on.tools[tool.id]===true;
      const entry={id:tool.id,name:tool.manifest?.name||tool.id,enabled,approved,overridden:Object.hasOwn(on.overrides.tools,tool.id),errors:tool.errors,warnings:tool.warnings,count:0};
      custom.push(entry);
      if(!tool.manifest||!enabled||!approved||!proxy)continue;
      Object.assign(entry,proxy.status());
      if(!listed){entry.state=entry.state==='stopped'?'loading':entry.state;continue;}
      const include=tool.manifest.tools?.include,exclude=new Set(tool.manifest.tools?.exclude||[]),rewrite=tool.manifest.tools?.descriptions||{};
      for(const upstream of listed){
        if(!upstream||typeof upstream.name!=='string'||(include&&!include.includes(upstream.name))||exclude.has(upstream.name))continue;
        const name=exposedName(tool.id,upstream.name);
        if(routes.has(name)){entry.errors=[...entry.errors,'name collision: '+name];continue;}
        const description=[rewrite[upstream.name]||upstream.description||upstream.name,tool.manifest.instructions].filter(Boolean).join(' ').slice(0,2048);
        tools.push({...upstream,name,description:'['+tool.manifest.name+'] '+description,inputSchema:plainSchema(upstream.inputSchema)||{type:'object'},...upstream.outputSchema?{outputSchema:plainSchema(upstream.outputSchema)}:{}});
        routes.set(name,{proxy,upstream:upstream.name});entry.count++;
      }
      // Resources keep their URIs (the first tool wins a duplicate); prompts get the tool prefix.
      const extras=readToolExtras(stateDir,tool.id,tool.hash);
      for(const resource of extras.resources)if(resource&&typeof resource.uri==='string'&&!resourceRoutes.has(resource.uri)){resources.push({...resource,name:'['+tool.manifest.name+'] '+(resource.name||resource.uri)});resourceRoutes.set(resource.uri,proxy);}
      for(const prompt of extras.prompts){if(!prompt||typeof prompt.name!=='string')continue;const name=exposedName(tool.id,prompt.name);if(promptRoutes.has(name))continue;prompts.push({...prompt,name});promptRoutes.set(name,{proxy,upstream:prompt.name});}
    }
    const parts=[instructions.base||''];
    if(groups.has('blender')&&instructions.blender)parts.push(instructions.blender);
    if(custom.some(t=>t.enabled&&t.count))parts.push('Tools named <tool>__<name> are third-party MCP servers the user installed on this local computer; they run with the user\'s local account.');
    const enabledGroups=[...groups];
    const view={tools,routes,resources,resourceRoutes,prompts,promptRoutes,instructions:parts.filter(Boolean).join(' '),groups:enabledGroups,exposure:settings.exposure,revision:sha(JSON.stringify([tools,parts,enabledGroups,settings.exposure,resources,prompts])),custom,settings};
    views.set(device,view);return view;
  }
  // Recompute when anything that decides the lists changed; emit only if a device's list changed.
  function check(force=false,device=''){
    if(closed)return base?viewFor(device):null;
    const next=fingerprint(stateDir,root);
    if(force||!base||next!==stamp){
      const before=new Map([...views].map(([d,v])=>[d,v.revision]));
      stamp=next;base=buildBase();views.clear();
      let changed=false;for(const [d,revision] of before)if(viewFor(d).revision!==revision)changed=true;
      if(changed)events.emit('changed');
    }
    return viewFor(device);
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
    try{fs.mkdirSync(path.join(stateDir,'tool-cache'),{recursive:true});}catch{}
    for(const [target,recursive] of [[stateDir,false],[root,true],[path.join(stateDir,'tool-cache'),false]]){
      try{watchers.push(fs.watch(target,{recursive,persistent:false},onFiles));}
      catch{try{watchers.push(fs.watch(target,{persistent:false},onFiles));}catch{}}
    }
    for(const w of watchers)w.on('error',()=>{});
  }
  const deviceIn=ctx=>typeof ctx?.device==='string'?ctx.device:'';
  async function call(name,args,ctx){
    const current=check(false,deviceIn(ctx)),route=current.routes.get(name);
    if(!route)return null;
    if(route.provider)return route.provider.call(name,args);
    return route.proxy.call(route.upstream,args,ctx);
  }
  // ctx: {device, ask}. device picks that device's switches; ask (when the channel can carry it)
  // forwards a third-party tool's question to the user of that call.
  async function forward(msg,ctx){
    const id=msg?.id??null,error=(code,message)=>({jsonrpc:'2.0',id,error:{code,message}}),device=deviceIn(ctx);
    if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||(id!==null&&typeof id!=='string'&&typeof id!=='number'))return error(-32600,'Invalid JSON-RPC request');
    if(!Object.hasOwn(msg,'id'))return null;
    let result;
    if(msg.method==='initialize'){
      const current=check(false,device);
      result={protocolVersion:PROTOCOLS.includes(msg.params?.protocolVersion)?msg.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:serverName,version},instructions:current.instructions};
    } else if(msg.method==='ping')result={};
    else if(msg.method==='tools/list'){const current=check(false,device);result={tools:current.tools,_meta:{'cmcp/catalog':{schema:1,revision:current.revision,groups:current.groups,exposure:current.exposure,resources:current.resources.length,prompts:current.prompts.length}}};}
    else if(msg.method==='resources/list')result={resources:check(false,device).resources};
    else if(msg.method==='resources/templates/list')result={resourceTemplates:[]};
    else if(msg.method==='prompts/list')result={prompts:check(false,device).prompts};
    else if(msg.method==='resources/read'||msg.method==='prompts/get'){
      const current=check(false,device),p=msg.params||{};
      const route=msg.method==='resources/read'?current.resourceRoutes.get(p.uri):current.promptRoutes.get(p.name);
      if(!route)return error(-32602,(msg.method==='resources/read'?'Unknown resource: ':'Unknown prompt: ')+(p.uri||p.name));
      try{result=msg.method==='resources/read'?await route.request('resource',{uri:p.uri},ctx):await route.proxy.request('prompt',{name:route.upstream,arguments:p.arguments},ctx);}
      catch(e){return error(-32603,e.message);}
    }
    else if(msg.method==='tools/call'){
      const p=msg.params;
      if(!p||typeof p.name!=='string'||(p.arguments!==undefined&&(!p.arguments||typeof p.arguments!=='object'||Array.isArray(p.arguments))))return error(-32602,'Invalid tool call');
      if(!check(false,device).routes.has(p.name))return error(-32602,builtinNames.has(p.name)?'Tool '+p.name+' is turned off in CMCP for this device':'Unknown tool: '+p.name);
      if(active>=16)return error(-32000,'Too many active requests');
      active++;
      try{result=await call(p.name,p.arguments??{},ctx);}
      catch(e){result=text(e.message||'Local tool failed; check the operation status before retrying.');}
      finally{active--;}
    } else return error(-32601,'Method not found');
    return {jsonrpc:'2.0',id,result};
  }
  return {
    forward,
    list:(device='')=>check(false,device),
    revision:(device='')=>check(false,device).revision,
    instructions:(device='')=>check(false,device).instructions,
    call:async(name,args,ctx)=>{const r=await call(name,args,ctx);return r??text('Unknown tool: '+name);},
    has:(name,device='')=>check(false,device).routes.has(name),
    on:(event,fn)=>{events.on(event,fn);return ()=>events.off(event,fn);},
    refresh(){for(const p of proxies.values()){p.failures=[];warm(p);}return check(true);},
    custom:(device='')=>check(false,device).custom,
    // The tool host serves other CMCP processes from these processes (app/tool-host.mjs).
    proxy:id=>{check();return proxies.get(id)||null;},
    async close(){closed=true;clearTimeout(timer);for(const w of watchers)try{w.close();}catch{};await Promise.allSettled([...proxies.values()].map(p=>p.close()));proxies.clear();},
  };
}
