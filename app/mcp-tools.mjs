// Local MCP tools (interface cmcp-tools/1): built-in groups switched on or off for this
// computer, and third-party MCP servers the user put into the mcp-tools folder, one
// subfolder per tool with a cmcp-tool.json. Shared by Windows and Mac. Settings and
// secrets stay in the private state folder; mcp-tools holds only shareable files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const INTERFACE='cmcp-tools/1';
export const GROUPS=['files','commands','processes','toolchains','desktop','blender'];
export const DEFAULT_GROUPS={files:true,commands:true,processes:true,toolchains:true,desktop:true,blender:false};
export const DEFAULT_IDLE_MINUTES=30;
export const ID=/^[a-z][a-z0-9_]{0,19}$/;
export const RESERVED=new Set(['cmcp','windows','mac','files','binary','blender','system']);
export const LOCAL_NAME_LIMIT=32;
const sha=value=>createHash('sha256').update(value).digest('hex');
const here=path.dirname(fileURLToPath(import.meta.url));

// Built-in tool -> group. Filesystem server tools carry no prefix and belong to files;
// an unknown platform tool counts as system (always on) so nothing disappears silently.
const PLATFORM_GROUPS={
  execute:'commands',run_program:'commands',
  start_process:'processes',process_status:'processes',process_input:'processes',process_stdin:'processes',stop_process:'processes',list_sessions:'processes',list_processes:'processes',
  toolchain_info:'toolchains',adb:'toolchains',adb_devices:'toolchains',
  screenshot:'desktop',desktop_action:'desktop',browser_open:'desktop',keyboard:'desktop',open_url:'desktop',open_path:'desktop',
  system_info:'system',
};
export function groupOf(name){
  if(/^blender_/.test(name))return 'blender';
  const platform=/^(?:windows|mac)_(.+)$/.exec(name);
  if(!platform)return 'files';
  if(/^binary_/.test(platform[1])||/_(?:to|from)_cloud$/.test(platform[1]))return 'files';
  return PLATFORM_GROUPS[platform[1]]||'system';
}

/* ---------------- Folders and settings ---------------- */

// Windows keeps state in <install>\user, so mcp-tools sits beside it; on the Mac the state
// folder is ~/Library/Application Support/CMCP itself and mcp-tools sits inside it.
export function toolsRoot(stateDir,platform=process.platform,env=process.env){
  if(env.CMCP_MCP_TOOLS_DIR)return path.resolve(env.CMCP_MCP_TOOLS_DIR);
  return platform==='win32'?path.join(path.dirname(path.resolve(stateDir)),'mcp-tools'):path.join(path.resolve(stateDir),'mcp-tools');
}
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function atomicWrite(file,text,mode=0o600){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.'+randomBytes(6).toString('hex')+'.tmp';
  try{
    fs.writeFileSync(temporary,text,{flag:'wx',mode});
    for(let attempt=0;;attempt++){
      // A Windows scanner can briefly hold the old file; retry the replacement a few times.
      try{fs.renameSync(temporary,file);break;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=20)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}
    }
  }finally{try{fs.unlinkSync(temporary);}catch{}}
}
const settingsFile=stateDir=>path.join(stateDir,'tool-settings.json');
export const refreshFile=stateDir=>path.join(stateDir,'tool-refresh.json');
// One set of switches for this computer. `targets` is reserved for per-device overrides.
export function readSettings(stateDir){
  let saved={};try{saved=readJson(settingsFile(stateDir));if(!saved||typeof saved!=='object'||Array.isArray(saved)||saved.schema!==1)saved={};}catch{}
  const groups={...DEFAULT_GROUPS};
  for(const name of GROUPS)if(typeof saved.groups?.[name]==='boolean')groups[name]=saved.groups[name];
  const tools={};for(const [id,on] of Object.entries(saved.tools||{}))if(ID.test(id)&&typeof on==='boolean')tools[id]=on;
  const acknowledged={};for(const [id,value] of Object.entries(saved.acknowledged||{}))if(ID.test(id)&&/^[a-f0-9]{64}$/.test(value))acknowledged[id]=value;
  const idle=saved.idleMinutes;
  return {schema:1,groups,tools,acknowledged,idleMinutes:Number.isInteger(idle)&&idle>=0&&idle<=1440?idle:DEFAULT_IDLE_MINUTES,
    blenderOffer:{done:saved.blenderOffer?.done===true},targets:readOverrides(saved.targets)};
}
// Per-device overrides on top of the switches for this computer: {device: {groups, tools}}.
// A missing entry follows the global switch. Approval (acknowledged) stays per computer.
export const DEVICE=/^[^\x00-\x1f]{1,480}$/;
function readOverrides(value){
  const result={};if(!value||typeof value!=='object'||Array.isArray(value))return result;
  for(const [device,entry] of Object.entries(value)){
    if(!DEVICE.test(device)||!entry||typeof entry!=='object')continue;
    const groups={},tools={};
    for(const [name,on] of Object.entries(entry.groups||{}))if(GROUPS.includes(name)&&typeof on==='boolean')groups[name]=on;
    for(const [id,on] of Object.entries(entry.tools||{}))if(ID.test(id)&&typeof on==='boolean')tools[id]=on;
    if(Object.keys(groups).length||Object.keys(tools).length)result[device]={groups,tools};
  }
  return result;
}
// The switches as one device sees them.
export function effectiveSwitches(settings,device){
  const own=device&&settings.targets[device]||{groups:{},tools:{}};
  return {groups:{...settings.groups,...own.groups},tools:{...settings.tools,...own.tools},overrides:own};
}
// A backend connection name (web: <id>, CloudCLI: cloudcli:<id>, SSH web tunnel: tunnel:<app>:<id>)
// and the SSH channel's id all name the same device card.
export const deviceOf=name=>typeof name==='string'&&name?name.replace(/^tunnel:[a-z]+:/,'').replace(/^cloudcli:/,''):null;
export function writeSettings(stateDir,settings){atomicWrite(settingsFile(stateDir),JSON.stringify(settings,null,2)+'\n');}
export function updateSettings(stateDir,edit){const settings=readSettings(stateDir);edit(settings);writeSettings(stateDir,settings);return settings;}
// Every running CMCP process watches this file: a manual refresh re-reads tools and caches.
export function requestRefresh(stateDir){atomicWrite(refreshFile(stateDir),JSON.stringify({at:Date.now(),nonce:randomUUID()})+'\n');}

/* ---------------- Manifest, schema 1 ---------------- */

export const KNOWN_COMMANDS=new Set(['npx','npm','uvx','uv','node','python','python3','py','deno','bun','docker','pipx']);
export const CAPABILITIES=['files','exec','python','network','gui','hardware','credentials'];
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]','::1']);
const KNOWN_FIELDS=new Set(['schema','name','description','version','homepage','license','transport','command','args','cwd','env','url','headers','start','platforms','requires','capabilities','instructions','lifecycle','timeouts','maxConcurrency','tools','preset']);
const SECRET_VALUE=/^(?:sk-|sk_|ghp_|gho_|github_pat_|xox[bpas]-|AKIA|AIza|-----BEGIN)/;
const SECRET_KEY=/TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
const str=(value,max,min=1)=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\x00]/.test(value);
function inside(base,target){const relative=path.relative(base,target);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));}
function checkValues(record,where,errors,warnings,secrets){
  if(record===undefined)return;
  if(!record||typeof record!=='object'||Array.isArray(record)){errors.push(where+' must be an object');return;}
  for(const [key,value] of Object.entries(record)){
    if(!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(key)){errors.push(where+'.'+key+': invalid name');continue;}
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      if(value.secret!==true){errors.push(where+'.'+key+': only {"secret":true} objects are allowed');continue;}
      if(value.template!==undefined&&!(str(value.template,512)&&value.template.includes('{value}'))){errors.push(where+'.'+key+'.template must contain {value}');continue;}
      secrets.push(key);continue;
    }
    if(!str(value,8192,0)){errors.push(where+'.'+key+' must be a string');continue;}
    if(SECRET_VALUE.test(value)||(SECRET_KEY.test(key)&&value.length>=8))warnings.push({code:'SECRET_IN_MANIFEST',field:where+'.'+key});
  }
}
export function parseManifest(text,{id,dir,platform=process.platform}={}){
  const errors=[],warnings=[],secrets=[];
  if(typeof text!=='string'||Buffer.byteLength(text)>64*1024)return {errors:['cmcp-tool.json must be at most 64 KiB'],warnings,secrets};
  let m;try{m=JSON.parse(text.replace(/^\uFEFF/,''));}catch{return {errors:['cmcp-tool.json is not valid JSON'],warnings,secrets};}
  if(!m||typeof m!=='object'||Array.isArray(m))return {errors:['cmcp-tool.json must be a JSON object'],warnings,secrets};
  if(m.schema!==1)return {errors:[Number.isInteger(m.schema)&&m.schema>1?'This tool needs a newer CMCP (schema '+m.schema+')':'schema must be 1'],warnings,secrets};
  for(const key of Object.keys(m))if(!KNOWN_FIELDS.has(key))warnings.push({code:'UNKNOWN_FIELD',field:key});
  if(!str(m.name,60))errors.push('name must be 1-60 characters');
  if(!str(m.description,200))errors.push('description must be 1-200 characters');
  for(const key of ['version','license'])if(m[key]!==undefined&&!str(m[key],64))errors.push(key+' must be a short string');
  if(m.homepage!==undefined&&!(str(m.homepage,512)&&/^https:\/\//.test(m.homepage)))errors.push('homepage must be an https link');
  if(!['stdio','http'].includes(m.transport))errors.push('transport must be "stdio" or "http"');
  const checkCommand=(command,args,where)=>{
    if(!str(command,1024)){errors.push(where+'command is required');return;}
    if(!KNOWN_COMMANDS.has(command)){
      const relative=command.startsWith('./');
      if(!relative&&!path.isAbsolute(command)&&!path.win32.isAbsolute(command))errors.push(where+'command must be one of '+[...KNOWN_COMMANDS].join(', ')+', an absolute path or ./relative path');
      else if(relative&&dir&&!inside(dir,path.resolve(dir,command)))errors.push(where+'command leaves the tool folder');
    }
    if(args!==undefined&&(!Array.isArray(args)||args.length>256||args.some(a=>!str(a,4096,0))))errors.push(where+'args must be an array of strings');
    else for(const arg of args||[])if(SECRET_VALUE.test(arg))warnings.push({code:'SECRET_IN_MANIFEST',field:where+'args'});
    if(args?.some(a=>/@latest$/.test(a))||(['npx','uvx'].includes(command)&&args?.length&&!args.some(a=>/@\d|==\d|@[\w.-]*\d/.test(a))))warnings.push({code:'UNPINNED',field:where+'args'});
  };
  if(m.transport==='stdio')checkCommand(m.command,m.args,'');
  if(m.transport==='http'){
    let url;try{url=new URL(m.url);}catch{}
    if(!url||!['http:','https:'].includes(url.protocol)||!LOOPBACK.has(url.hostname))errors.push('url must be http(s)://127.0.0.1, localhost or [::1]');
    checkValues(m.headers,'headers',errors,warnings,secrets);
    if(m.start!==undefined){if(!m.start||typeof m.start!=='object'||Array.isArray(m.start))errors.push('start must be an object');else checkCommand(m.start.command,m.start.args,'start.');}
  }
  if(m.cwd!==undefined&&!(str(m.cwd,1024)&&(!dir||inside(dir,path.resolve(dir,m.cwd)))))errors.push('cwd must stay inside the tool folder');
  checkValues(m.env,'env',errors,warnings,secrets);
  if(m.platforms!==undefined&&(!Array.isArray(m.platforms)||!m.platforms.length||m.platforms.some(p=>!['win32','darwin'].includes(p))))errors.push('platforms must list win32 and/or darwin');
  if(m.requires!==undefined&&(!Array.isArray(m.requires)||m.requires.length>16||m.requires.some(r=>!r||typeof r!=='object'||!str(r.runtime,32)||(r.min!==undefined&&!str(r.min,32))||(r.name!==undefined&&!str(r.name,60))||(r.hint!==undefined&&!str(r.hint,512)))))errors.push('requires must be a list of {runtime, min?, name?, hint?}');
  if(!Array.isArray(m.capabilities)||m.capabilities.some(c=>!CAPABILITIES.includes(c)))errors.push('capabilities must list any of '+CAPABILITIES.join(', '));
  if(m.instructions!==undefined&&!str(m.instructions,300))errors.push('instructions must be at most 300 characters');
  if(m.lifecycle!==undefined&&!['on-demand','persistent'].includes(m.lifecycle))errors.push('lifecycle must be "on-demand" or "persistent"');
  if(m.timeouts!==undefined){const t=m.timeouts;if(!t||typeof t!=='object'||(t.startMs!==undefined&&!(Number.isInteger(t.startMs)&&t.startMs>=1000&&t.startMs<=120000))||(t.callMs!==undefined&&!(Number.isInteger(t.callMs)&&t.callMs>=1000&&t.callMs<=600000)))errors.push('timeouts.startMs must be 1000-120000 and callMs 1000-600000');}
  if(m.maxConcurrency!==undefined&&!(Number.isInteger(m.maxConcurrency)&&m.maxConcurrency>=1&&m.maxConcurrency<=16))errors.push('maxConcurrency must be 1-16');
  if(m.tools!==undefined){
    const t=m.tools,list=v=>v===undefined||(Array.isArray(v)&&v.length<=512&&v.every(n=>str(n,128)));
    if(!t||typeof t!=='object'||!list(t.include)||!list(t.exclude)||(t.descriptions!==undefined&&(typeof t.descriptions!=='object'||Object.values(t.descriptions).some(d=>!str(d,1024)))))errors.push('tools must hold include/exclude name lists and short descriptions');
  }
  if(id!==undefined&&!ID.test(id))errors.push('folder name must match '+ID+' (lower-case letters, digits, _; at most 20)');
  else if(id!==undefined&&(RESERVED.has(id)||id.includes('__')))errors.push('folder name "'+id+'" is reserved');
  if(m.platforms&&!m.platforms.includes(platform)&&['win32','darwin'].includes(platform))errors.push('not available on this computer ('+platform+')');
  return {manifest:errors.length?undefined:m,errors,warnings,secrets};
}
// What the user confirms before first use: changes to the command or capabilities ask again.
export const approvalKey=m=>sha(JSON.stringify([m.transport,m.command||'',m.args||[],m.url||'',m.start||null,[...m.capabilities].sort()]));
export function describeTool(m){
  const command=m.transport==='http'?(m.start?[m.start.command,...m.start.args||[]].join(' ')+' → '+m.url:m.url):[m.command,...m.args||[]].join(' ');
  const zh={files:'读写你的文件',exec:'运行任意命令',python:'运行 Python 代码',network:'联网',gui:'操作桌面程序',hardware:'访问外接设备',credentials:'使用账号或令牌'};
  const en={files:'read and write your files',exec:'run any command',python:'run Python code',network:'use the network',gui:'control desktop programs',hardware:'use attached devices',credentials:'use accounts or tokens'};
  const caps=m.capabilities;
  return {
    zh:`${m.name} 会以你的账户运行 ${command}，${caps.length?'能'+caps.map(c=>zh[c]).join('、'):'作者声明它不读写文件、不运行命令、不联网'}。这些能力由作者声明，CMCP 无法限制它实际能做什么。`,
    en:`${m.name} runs ${command} as your account and ${caps.length?'can '+caps.map(c=>en[c]).join(', '):'is declared to use no files, commands or network'}. The author declares these abilities; CMCP cannot limit what it actually does.`,
  };
}

/* ---------------- Folder scan ---------------- */

export function scanTools(root,{platform=process.platform}={}){
  let names=[];try{names=fs.readdirSync(root,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;return [];}
  const tools=[];
  for(const entry of names){
    if(!entry.isDirectory()||entry.name.startsWith('_')||entry.name.startsWith('.'))continue;
    const dir=path.join(root,entry.name),file=path.join(dir,'cmcp-tool.json');
    let text,stat;
    try{stat=fs.lstatSync(file);if(!stat.isFile())throw Error();text=fs.readFileSync(file,'utf8');}
    catch{tools.push({id:entry.name,dir,errors:['cmcp-tool.json is missing'],warnings:[],secrets:[]});continue;}
    const parsed=parseManifest(text,{id:entry.name,dir,platform});
    tools.push({id:entry.name,dir,...parsed,hash:sha(text),stamp:stat.mtimeMs+':'+stat.size});
  }
  return tools.sort((a,b)=>a.id.localeCompare(b.id));
}
// Cheap fingerprint of everything that decides the tool list; recomputed on every tools/list.
export function fingerprint(stateDir,root){
  const parts=[];
  for(const file of [settingsFile(stateDir),refreshFile(stateDir)]){try{const s=fs.statSync(file);parts.push(file+':'+s.mtimeMs+':'+s.size);}catch{parts.push(file+':-');}}
  // Tool lists read by another CMCP process (the tool host) count as a change too.
  try{const cache=path.join(stateDir,'tool-cache');for(const name of fs.readdirSync(cache).sort()){const s=fs.statSync(path.join(cache,name));parts.push('cache/'+name+':'+s.mtimeMs+':'+s.size);}}catch{}
  try{for(const entry of fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.isDirectory())continue;
    try{const s=fs.statSync(path.join(root,entry.name,'cmcp-tool.json'));parts.push(entry.name+':'+s.mtimeMs+':'+s.size);}catch{parts.push(entry.name+':-');}
  }}catch{parts.push('root:-');}
  return sha(parts.join('\n'));
}
// AGENT.md and the examples come from app/mcp-tools-template. A changed AGENT.md is kept and the
// new one is written beside it, so a user's own notes are never overwritten.
export function ensureToolsFolder(root){
  const template=path.join(here,'mcp-tools-template');
  fs.mkdirSync(root,{recursive:true});
  if(!fs.existsSync(template))return;
  const shipped=path.join(root,'.cmcp-template.json');let previous={};try{previous=readJson(shipped);}catch{}
  const copy=(relative,record)=>{
    const source=path.join(template,relative),target=path.join(root,relative),content=fs.readFileSync(source);
    const digest=sha(content);record[relative]=digest;
    let current=null;try{current=fs.readFileSync(target);}catch{}
    if(current&&sha(current)===digest)return;
    if(current&&previous[relative]!==sha(current)){
      if(relative==='AGENT.md')atomicWrite(path.join(root,'AGENT.cmcp-new.md'),content,0o644);
      return;
    }
    atomicWrite(target,content,0o644);
  };
  const record={};
  const walk=relative=>{for(const entry of fs.readdirSync(path.join(template,relative),{withFileTypes:true})){const next=path.join(relative,entry.name);if(entry.isDirectory()){fs.mkdirSync(path.join(root,next),{recursive:true});walk(next);}else copy(next,record);}};
  walk('');
  atomicWrite(shipped,JSON.stringify(record,null,2)+'\n',0o644);
}

/* ---------------- Names exposed to Claude ---------------- */

// <id>__<tool>. The full name Claude sees is mcp__<connector>__<this>; the SSH connector
// name is 25 characters, so this part stays within 32 to keep the whole name within 64.
export function exposedName(id,upstream){
  const clean=String(upstream).replace(/[^A-Za-z0-9_-]/g,'_')||'_';
  const name=id+'__'+clean;
  if(name.length<=LOCAL_NAME_LIMIT&&clean===upstream)return name;
  const keep=LOCAL_NAME_LIMIT-id.length-2-7;
  return id+'__'+clean.slice(0,Math.max(1,keep))+'_'+sha(String(upstream)).slice(0,6);
}

/* ---------------- Paste import ---------------- */

export function slug(name){
  let id=String(name).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').replace(/__+/g,'_');
  if(!/^[a-z]/.test(id))id='t_'+id;
  id=id.slice(0,20).replace(/_+$/,'');
  if(RESERVED.has(id))id=(id+'_mcp').slice(0,20);
  return ID.test(id)?id:'tool';
}
// Accepts the Claude Desktop snippet from a README, its inner object, or one server.
export function parseImport(text,{existing=new Set()}={}){
  let value;try{value=JSON.parse(String(text).trim().replace(/^\uFEFF/,''));}catch{
    try{value=JSON.parse('{'+String(text).trim().replace(/,\s*$/,'')+'}');}catch{throw Error('粘贴的内容不是有效的 JSON 配置');}
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('粘贴的内容不是 MCP 服务器配置');
  let servers=value.mcpServers??value.servers??null;
  if(!servers)servers=(typeof value.command==='string'||typeof value.url==='string')?{[value.name||'tool']:value}:value;
  if(!servers||typeof servers!=='object'||Array.isArray(servers)||!Object.keys(servers).length)throw Error('没有找到 MCP 服务器配置');
  const used=new Set(existing),items=[];
  for(const [name,server] of Object.entries(servers)){
    if(!server||typeof server!=='object'||Array.isArray(server))throw Error(name+'：配置不是对象');
    const type=server.type||(server.url?'http':'stdio');
    let id=slug(name);for(let n=2;used.has(id);n++)id=slug(name).slice(0,17)+'_'+n;used.add(id);
    const manifest={schema:1,name:String(name).slice(0,60),description:('MCP server '+name).slice(0,200),capabilities:['files','exec','network']};
    const secrets={};
    if(type==='stdio'){
      if(typeof server.command!=='string'||!server.command)throw Error(name+'：缺少 command');
      let command=server.command,args=Array.isArray(server.args)?server.args.map(String):[];
      // READMEs for Windows often wrap the command in "cmd /c"; CMCP starts it without a shell.
      if(/^cmd(?:\.exe)?$/i.test(command)&&/^\/[cC]$/.test(args[0]||'')&&args[1]){command=args[1].replace(/\.(?:cmd|exe)$/i,'');args=args.slice(2);}
      Object.assign(manifest,{transport:'stdio',command,...args.length?{args}:{}});
    } else if(['http','streamable-http','streamableHttp'].includes(type)){
      let url;try{url=new URL(server.url);}catch{}
      if(!url||!LOOPBACK.has(url.hostname))throw Error(name+'：远程 MCP 服务器请直接加在 VPS 上，不需要经过本机（CMCP 只代理本机 127.0.0.1 上的 HTTP 服务器）');
      Object.assign(manifest,{transport:'http',url:server.url});
      if(server.headers&&typeof server.headers==='object'){manifest.headers={};for(const [k,v] of Object.entries(server.headers)){manifest.headers[k]={secret:true};secrets['header:'+k]=String(v);}}
    } else throw Error(name+'：不支持 '+type+' 类型（只支持 stdio 和本机 HTTP）');
    if(server.cwd!==undefined)manifest.cwd='.';
    // Values that look like keys or tokens go to the secret store; settings such as ports stay in the manifest.
    if(server.env&&typeof server.env==='object'){manifest.env={};for(const [k,v] of Object.entries(server.env)){const value=String(v);if(SECRET_KEY.test(k)||SECRET_VALUE.test(value)){manifest.env[k]={secret:true};secrets['env:'+k]=value;}else manifest.env[k]=value;}}
    const parsed=parseManifest(JSON.stringify(manifest),{id});
    items.push({id,manifest,secrets,errors:parsed.errors,warnings:parsed.warnings});
  }
  return items;
}
// Keys in `plain` stay as normal values in the manifest; the rest go to the secret store.
export async function installImported(root,stateDir,item,{secrets,plain=[]}={}){
  const dir=path.join(root,item.id);
  if(fs.existsSync(dir))throw Error('mcp-tools 里已有同名文件夹：'+item.id);
  const manifest=structuredClone(item.manifest),hidden={};
  for(const [key,value] of Object.entries(item.secrets||{})){
    const [kind,name]=key.split(/:(.*)/s);
    if(plain.includes(key)&&kind==='env')manifest.env[name]=value;else hidden[key]=value;
    if(kind==='header'&&manifest.headers?.[name])manifest.headers[name]={secret:true};
  }
  if(Object.keys(hidden).length){if(!secrets)throw Error('Secret store unavailable');await saveSecrets(stateDir,item.id,hidden,secrets);}
  fs.mkdirSync(dir,{recursive:true});
  atomicWrite(path.join(dir,'cmcp-tool.json'),JSON.stringify(manifest,null,2)+'\n',0o644);
  return dir;
}

/* ---------------- Secrets ---------------- */

// Stored as {schema:1, values:{"env:NAME": <protected>}}. Windows protects values with DPAPI
// (current user), the Mac keeps them in the login keychain; the file only holds references.
const secretsFile=(stateDir,id)=>path.join(stateDir,'tool-secrets',id+'.json');
export async function saveSecrets(stateDir,id,values,store){
  const file=secretsFile(stateDir,id);let current={schema:1,values:{}};try{current=readJson(file);}catch{}
  for(const [key,value] of Object.entries(values))current.values[key]=await store.protect(value,current.values[key]);
  atomicWrite(file,JSON.stringify(current,null,2)+'\n');
}
export async function loadSecrets(stateDir,id,store){
  let data;try{data=readJson(secretsFile(stateDir,id));}catch{return {};}
  const values={};for(const [key,value] of Object.entries(data.values||{}))values[key]=await store.unprotect(value);
  return values;
}
export function secretNames(stateDir,id){try{return Object.keys(readJson(secretsFile(stateDir,id)).values||{});}catch{return [];}}
export async function removeSecrets(stateDir,id,store){
  let data;try{data=readJson(secretsFile(stateDir,id));}catch{return;}
  for(const value of Object.values(data.values||{}))await store.remove?.(value).catch?.(()=>{});
  fs.rmSync(secretsFile(stateDir,id),{force:true});
}
export function defaultSecretStore(platform=process.platform){
  if(platform==='win32')return {
    protect:async plain=>'dpapi:'+powershellDpapi('Protect',plain),
    unprotect:async stored=>{if(!stored.startsWith('dpapi:'))throw Error('Unknown secret format');return powershellDpapi('Unprotect',stored.slice(6));},
  };
  if(platform==='darwin')return {
    protect:async(plain,previous)=>{const {keychain}=await import('../macos/platform.mjs');const id=/^keychain:([a-f0-9-]{36})$/.exec(previous||'')?.[1]||randomUUID();await keychain('set',id,plain);return 'keychain:'+id;},
    unprotect:async stored=>{const {keychain}=await import('../macos/platform.mjs');const id=/^keychain:([a-f0-9-]{36})$/.exec(stored)?.[1];if(!id)throw Error('Unknown secret format');return keychain('get',id);},
    remove:async stored=>{const {keychain}=await import('../macos/platform.mjs');const id=/^keychain:([a-f0-9-]{36})$/.exec(stored)?.[1];if(id)await keychain('delete',id);},
  };
  return null;
}
function powershellDpapi(action,value){
  const script='$ErrorActionPreference="Stop";Add-Type -AssemblyName System.Security;$in=[Console]::In.ReadToEnd();$s=[Security.Cryptography.DataProtectionScope]::CurrentUser;'
    +(action==='Protect'?'[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in),$null,$s))'
      :'[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in),$null,$s))');
  const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const out=execFileSync(exe,['-NoProfile','-NonInteractive','-Command',script],{input:value,windowsHide:true,timeout:30000,encoding:'utf8'}).trim();
  return action==='Protect'?out:Buffer.from(out,'base64').toString('utf8');
}

/* ---------------- Runtimes ---------------- */

export const RUNTIME_HINTS={
  node:{zh:'需要 Node.js（含 npm/npx）。安装：https://nodejs.org ，Windows 也可运行 winget install OpenJS.NodeJS.LTS，Mac 可运行 brew install node',en:'Needs Node.js (with npm/npx): https://nodejs.org, or winget install OpenJS.NodeJS.LTS / brew install node'},
  uv:{zh:'需要 uv（含 uvx）。安装：Windows 运行 winget install astral-sh.uv，Mac 运行 brew install uv，或见 https://docs.astral.sh/uv/',en:'Needs uv (with uvx): winget install astral-sh.uv / brew install uv, or https://docs.astral.sh/uv/'},
  python:{zh:'需要 Python 3。安装：https://www.python.org/downloads/ ，Mac 也可运行 brew install python',en:'Needs Python 3: https://www.python.org/downloads/ or brew install python'},
  docker:{zh:'需要 Docker Desktop 并保持运行：https://www.docker.com/products/docker-desktop/',en:'Needs Docker Desktop running: https://www.docker.com/products/docker-desktop/'},
  deno:{zh:'需要 Deno：https://deno.com',en:'Needs Deno: https://deno.com'},
  bun:{zh:'需要 Bun：https://bun.sh',en:'Needs Bun: https://bun.sh'},
  pipx:{zh:'需要 pipx：https://pipx.pypa.io',en:'Needs pipx: https://pipx.pypa.io'},
};
export const runtimeOf=command=>({npx:'node',npm:'node',node:'node',uvx:'uv',uv:'uv',python:'python',python3:'python',py:'python'})[command]||command;
// GUI apps on the Mac do not inherit the login shell's PATH; read it once and add usual places.
let loginPath;
export function searchPath(platform=process.platform,env=process.env){
  const raw=env.PATH||env.Path||'';
  if(platform!=='darwin')return raw.split(path.delimiter).filter(Boolean);
  if(loginPath===undefined){
    loginPath='';
    try{const out=execFileSync('/bin/zsh',['-lc','printf "__CMCP_PATH__%s" "$PATH"'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});loginPath=out.split('__CMCP_PATH__').pop()||'';}catch{}
  }
  const home=os.homedir();
  const extra=['/opt/homebrew/bin','/usr/local/bin',path.join(home,'.local/bin'),path.join(home,'.cargo/bin'),path.join(home,'.volta/bin'),path.join(home,'.deno/bin'),path.join(home,'.bun/bin'),'/usr/bin','/bin'];
  try{const nvm=path.join(home,'.nvm/versions/node');for(const v of fs.readdirSync(nvm).sort().reverse())extra.push(path.join(nvm,v,'bin'));}catch{}
  return [...new Set([...loginPath.split(':'),...raw.split(':'),...extra].filter(Boolean))];
}
export function findExecutable(name,{platform=process.platform,env=process.env,dirs=searchPath(platform,env)}={}){
  const extensions=platform==='win32'?(path.extname(name)?['']:['.exe','.cmd','.bat','.com']):[''];
  for(const dir of dirs)for(const ext of extensions){
    const file=(platform==='win32'?path.win32:path.posix).join(dir,name+ext);
    try{const s=fs.statSync(file);if(s.isFile()&&(platform==='win32'||(s.mode&0o111)))return file;}catch{}
  }
  return null;
}
export class RuntimeMissing extends Error{
  constructor(runtime,detail){const hint=RUNTIME_HINTS[runtime]||{zh:'需要 '+runtime,en:'Needs '+runtime};super(detail||hint.zh);Object.assign(this,{code:'RUNTIME_MISSING',runtime,hint});}
}
// Turns a manifest command into something spawn() can run without a shell. Windows refuses to
// start .cmd/.bat without one (CVE-2024-27980), so npx and npm run as node + npm's own script.
export function resolveLaunch(command,args=[],{platform=process.platform,env=process.env,dir,dirs,bundledNode=process.execPath}={}){
  const look=name=>findExecutable(name,{platform,env,...dirs?{dirs}:{}});
  if(command.startsWith('./')){const file=path.resolve(dir,command);if(!fs.existsSync(file))throw Error('找不到 '+command);return {command:file,args};}
  if(!KNOWN_COMMANDS.has(command)){
    if(!fs.existsSync(command))throw Error('找不到程序：'+command);
    if(platform==='win32'&&/\.(?:cmd|bat)$/i.test(command))throw Error('Windows 不允许不经命令行直接启动 .cmd/.bat；请在 command 里写 .exe 的完整路径');
    return {command,args};
  }
  if(platform==='win32'&&['npx','npm'].includes(command)){
    const shim=look(command);if(!shim)throw new RuntimeMissing('node');
    const folder=path.win32.dirname(shim),script=path.win32.join(folder,'node_modules','npm','bin',command+'-cli.js');
    const node=fs.existsSync(path.win32.join(folder,'node.exe'))?path.win32.join(folder,'node.exe'):look('node.exe');
    if(!fs.existsSync(script)||!node)throw new RuntimeMissing('node','找到了 '+shim+'，但没有找到它对应的 npm 脚本或 node.exe；请重新安装 Node.js');
    return {command:node,args:[script,...args]};
  }
  if(command==='node'){const node=look('node');return {command:node||bundledNode,args};}
  let found=look(command);
  if(!found&&platform==='win32'&&command==='python')found=look('py');
  if(!found&&command==='python')found=look('python3');
  if(!found)throw new RuntimeMissing(runtimeOf(command));
  if(platform==='win32'&&/\.(?:cmd|bat)$/i.test(found))throw new RuntimeMissing(runtimeOf(command),'找到的是 '+found+'（.cmd/.bat），Windows 不允许不经命令行直接启动；请安装提供 .exe 的版本');
  return {command:found,args};
}

/* ---------------- Blender detection ---------------- */

export function detectBlender(platform=process.platform,env=process.env){
  const exists=file=>{try{return fs.statSync(file).isFile()||fs.statSync(file).isDirectory();}catch{return false;}};
  if(platform==='darwin'){for(const app of ['/Applications/Blender.app',path.join(os.homedir(),'Applications/Blender.app')])if(exists(app))return app;return null;}
  if(platform!=='win32')return null;
  const roots=[env.ProgramFiles||'C:\\Program Files',env['ProgramFiles(x86)']||'C:\\Program Files (x86)'];
  for(const root of roots){
    const foundation=path.win32.join(root,'Blender Foundation');
    try{for(const name of fs.readdirSync(foundation).sort().reverse()){const exe=path.win32.join(foundation,name,'blender.exe');if(exists(exe))return exe;}}catch{}
  }
  for(const root of roots){const steam=path.win32.join(root,'Steam','steamapps','common','Blender','blender.exe');if(exists(steam))return steam;}
  try{
    const out=execFileSync('reg.exe',['query','HKLM\\SOFTWARE\\BlenderFoundation','/v','Install_Dir'],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']});
    const dir=/Install_Dir\s+REG_SZ\s+(.+)/.exec(out)?.[1]?.trim();if(dir&&exists(path.win32.join(dir,'blender.exe')))return path.win32.join(dir,'blender.exe');
  }catch{}
  return null;
}

// Programs a preset needs on this computer, by name. Only fixed, well-known install places are
// checked; nothing is searched or started.
export function detectChrome(platform=process.platform,env=process.env){
  const exists=file=>{try{return fs.statSync(file).isFile()||fs.statSync(file).isDirectory();}catch{return false;}};
  if(platform==='darwin'){for(const app of ['/Applications/Google Chrome.app',path.join(os.homedir(),'Applications/Google Chrome.app')])if(exists(app))return app;return null;}
  if(platform!=='win32')return null;
  for(const root of [env.ProgramFiles||'C:\\Program Files',env['ProgramFiles(x86)']||'C:\\Program Files (x86)',env.LOCALAPPDATA].filter(Boolean)){
    const exe=path.win32.join(root,'Google','Chrome','Application','chrome.exe');if(exists(exe))return exe;
  }
  return null;
}
export function detectApp(name,platform=process.platform,env=process.env){
  if(name==='blender')return detectBlender(platform,env);
  if(name==='chrome')return detectChrome(platform,env);
  return null;
}

/* ---------------- Logs ---------------- */

export function toolLogFile(stateDir,id){return path.join(stateDir,'tool-logs',id+'.log');}
export function appendLog(stateDir,id,text,redact=[]){
  try{
    const file=toolLogFile(stateDir,id);fs.mkdirSync(path.dirname(file),{recursive:true});
    if(fs.statSync(file,{throwIfNoEntry:false})?.size>1024*1024)fs.renameSync(file,file+'.old');
    let line=String(text);for(const secret of redact)if(secret&&secret.length>=4)line=line.split(secret).join('***');
    fs.appendFileSync(file,new Date().toISOString()+' '+line.replace(/\r?\n(?=.)/g,'\n    ')+(line.endsWith('\n')?'':'\n'),{mode:0o600});
  }catch{}
}
