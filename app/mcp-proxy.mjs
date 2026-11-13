// One third-party MCP server from the mcp-tools folder, reached through the MCP SDK client: run
// on this computer (stdio: npx, uvx, python, ...; or HTTP on the loopback address), or a remote
// server over https (Streamable HTTP or SSE, with an OAuth sign-in when the manifest asks for one).
// Starts when first needed, stops after the idle time, never retries a call it already sent.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {McpError,ErrorCode,ToolListChangedNotificationSchema,ResourceListChangedNotificationSchema,PromptListChangedNotificationSchema,ElicitRequestSchema,CreateMessageRequestSchema,ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {pathToFileURL} from 'node:url';
import {appendLog,loadSecrets,resolveLaunch,atomicWrite,isRemote} from './mcp-tools.mjs';
import {ToolOAuth,LOGIN_MESSAGE,markLogin} from './mcp-oauth.mjs';

export const UNCERTAIN='The call was sent but its result was not confirmed; it may still be running or may have finished. It was not retried. Check the actual state before trying again. (操作已发送但结果未确认，未重试；请先检查实际状态。)';
// Variables of CMCP itself never reach a third-party process.
const PRIVATE_ENV=/^(?:CMCP_|CLOUDPC_|SSH_ASKPASS|DISPLAY$)/i;
const cacheFile=(stateDir,id)=>path.join(stateDir,'tool-cache',id+'.json');
export function readToolCache(stateDir,id,hash){
  try{const data=JSON.parse(fs.readFileSync(cacheFile(stateDir,id),'utf8'));return data.schema===1&&data.hash===hash&&Array.isArray(data.tools)?data.tools:null;}catch{return null;}
}
// Resources and prompts the server lists, kept with its tools.
export function readToolExtras(stateDir,id,hash){
  try{const data=JSON.parse(fs.readFileSync(cacheFile(stateDir,id),'utf8'));if(data.schema!==1||data.hash!==hash)return {resources:[],prompts:[]};
    return {resources:Array.isArray(data.resources)?data.resources:[],prompts:Array.isArray(data.prompts)?data.prompts:[]};}catch{return {resources:[],prompts:[]};}
}
function writeToolCache(stateDir,id,hash,tools,extras={}){atomicWrite(cacheFile(stateDir,id),JSON.stringify({schema:1,hash,at:Date.now(),tools,resources:extras.resources||[],prompts:extras.prompts||[]}));}

export class ProxyServer {
  constructor({id,manifest,hash,dir,stateDir,platform=process.platform,env=process.env,secrets,idleMs=30*60000,onToolsChanged=()=>{},launch=resolveLaunch,breaker={failures:3,windowMs:10*60000},roots=[]}){
    Object.assign(this,{id,manifest,hash,dir,stateDir,platform,env,secrets,idleMs,onToolsChanged,launch,breaker,roots});
    this.client=null;this.starting=null;this.active=0;this.calls=[];this.waiting=[];this.failures=[];this.state='stopped';this.error=null;this.idleTimer=null;this.redact=[];this.child=null;this.closed=false;
  }
  log(text){appendLog(this.stateDir,this.id,text,this.redact);}
  cachedTools(){return readToolCache(this.stateDir,this.id,this.hash);}
  status(){return {state:this.state,error:this.error};}
  tripped(){const now=Date.now();this.failures=this.failures.filter(t=>now-t<this.breaker.windowMs);return this.failures.length>=this.breaker.failures;}
  // {data}: this tool's private folder in the user's state (kept apart from the shareable
  // mcp-tools folder); {tool}: the tool's own folder. Used in env values and args.
  expand(value){
    if(typeof value!=='string'||!/\{(?:data|tool)\}/.test(value))return value;
    const data=path.join(this.stateDir,'tool-data',this.id);
    if(value.includes('{data}'))fs.mkdirSync(data,{recursive:true,mode:0o700});
    return value.split('{data}').join(data).split('{tool}').join(this.dir);
  }
  async environment(){
    const env={};for(const [k,v] of Object.entries(this.env))if(!PRIVATE_ENV.test(k)&&typeof v==='string')env[k]=v;
    const secrets=this.secrets?await loadSecrets(this.stateDir,this.id,this.secrets):{};
    // Sign-in tokens are kept as JSON; their values are hidden from the log one by one.
    this.redact=Object.values(secrets).flatMap(v=>{try{const t=JSON.parse(v);return t&&typeof t==='object'?[v,...Object.values(t).filter(x=>typeof x==='string'&&x.length>=8)]:[v];}catch{return [v];}});
    for(const [k,v] of Object.entries(this.manifest.env||{})){
      if(typeof v==='string')env[k]=this.expand(v);
      else if(secrets['env:'+k]!==undefined)env[k]=secrets['env:'+k];
      else throw Error('缺少密钥 '+k+'：请在 CMCP 的“工具”页重新导入或填写');
    }
    const headers={};
    for(const [k,v] of Object.entries(this.manifest.headers||{})){
      if(typeof v==='string')headers[k]=v;
      else if(secrets['header:'+k]!==undefined)headers[k]=v.template?v.template.replace('{value}',secrets['header:'+k]):secrets['header:'+k];
      else throw Error('缺少密钥 '+k);
    }
    return {env,headers};
  }
  start(){
    if(this.client)return Promise.resolve(this.client);
    if(this.closed)return Promise.reject(Error('Tool stopped'));
    if(this.tripped())return Promise.reject(Object.assign(Error('这个工具在 10 分钟内启动或运行失败了 3 次，已暂停；请查看日志后在“工具”页刷新'),{code:'TOOL_SUSPENDED'}));
    if(!this.starting)this.starting=this.connect().then(client=>{this.client=client;this.state='running';this.error=null;this.armIdle();return client;},error=>{
      // A sign-in the user has not done yet is not a failure of the tool.
      if(error.code!=='LOGIN_REQUIRED')this.failures.push(Date.now());
      this.state=error.code==='RUNTIME_MISSING'?'runtime-missing':error.code==='LOGIN_REQUIRED'?'login-required':'error';this.error=error.message;this.log('start failed: '+error.message);throw error;
    }).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async connect(){
    const m=this.manifest,{env,headers}=await this.environment(),cwd=path.resolve(this.dir,m.cwd||'.');
    const client=new Client({name:'cmcp-proxy',version:'1'},{capabilities:{elicitation:{},sampling:{},roots:{listChanged:false}}});
    // Roots: the folders this computer allows CMCP's file tools to use.
    client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:(this.roots||[]).map(root=>({uri:pathToFileURL(root).href,name:root}))}));
    // Sampling (the tool asks Claude to write something) goes the way questions go; a client that
    // cannot do it makes the request fail with a clear error.
    client.setRequestHandler(CreateMessageRequestSchema,async request=>{
      const ctx=this.calls.at(-1);
      if(!ctx?.ask)throw new McpError(ErrorCode.InvalidRequest,'This connection cannot ask Claude to write text (sampling)');
      this.log('sampling request forwarded to the cloud client');
      try{return await ctx.ask(request.params,'sampling/createMessage');}catch(error){throw new McpError(ErrorCode.InternalError,'Sampling failed: '+error.message);}
    });
    // A question during a call (elicitation) goes to the user of the latest running call, through
    // the channel it came from; where that channel cannot carry it, the question is declined.
    client.setRequestHandler(ElicitRequestSchema,async request=>{
      const ctx=this.calls.at(-1);
      if(!ctx?.ask){this.log('question declined: this connection cannot show it');return {action:'decline'};}
      this.log('question forwarded to the cloud user');
      try{const answer=await ctx.ask(request.params);this.log('question answered: '+(answer?.action||'?'));return answer&&typeof answer==='object'?answer:{action:'cancel'};}
      catch(error){this.log('question not answered: '+error.message);return {action:'cancel'};}
    });
    client.fallbackRequestHandler=async request=>{throw new McpError(ErrorCode.MethodNotFound,'CMCP does not support '+request.method+' from local tools yet; continue without it or report a clear error');};
    client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{this.refresh().catch(()=>{});});
    client.setNotificationHandler(ResourceListChangedNotificationSchema,()=>{this.refresh().catch(()=>{});});
    client.setNotificationHandler(PromptListChangedNotificationSchema,()=>{this.refresh().catch(()=>{});});
    let transport;
    if(m.transport==='stdio'){
      const launch=this.launch(m.command,(m.args||[]).map(a=>this.expand(a)),{platform:this.platform,env,dir:this.dir});
      this.log('start '+[launch.command,...launch.args].join(' '));
      transport=new StdioClientTransport({command:launch.command,args:launch.args,env,cwd,stderr:'pipe'});
      transport.stderr?.on('data',chunk=>this.log('stderr '+chunk.toString().trimEnd()));
    } else {
      if(m.start&&!this.child){
        const launch=this.launch(m.start.command,m.start.args||[],{platform:this.platform,env,dir:this.dir});
        this.log('start '+[launch.command,...launch.args].join(' '));
        this.child=spawn(launch.command,launch.args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        this.child.stdout.on('data',c=>this.log('stdout '+c.toString().trimEnd()));this.child.stderr.on('data',c=>this.log('stderr '+c.toString().trimEnd()));
        this.child.once('exit',code=>{this.log('http server exited '+code);this.child=null;this.dropped();});
        this.child.on('error',error=>this.log('http server failed: '+error.message));
      }
      if(m.auth?.type==='oauth'&&!this.oauth)this.oauth=new ToolOAuth({stateDir:this.stateDir,id:this.id,manifest:m,secrets:this.secrets});
      const options={requestInit:{headers},...this.oauth?{authProvider:this.oauth}:{}};
      transport=()=>m.transport==='sse'?new SSEClientTransport(new URL(m.url),options):new StreamableHTTPClientTransport(new URL(m.url),options);
    }
    // A local server may still be starting, so connecting is retried; a remote one is asked once.
    const retry=typeof transport==='function'&&!isRemote(m);
    const deadline=Date.now()+(m.timeouts?.startMs||30000);
    for(;;){
      const current=typeof transport==='function'?transport():transport;
      try{
        await Promise.race([client.connect(current),delay(Math.max(1,deadline-Date.now())).then(()=>{throw Error('启动超时（'+(m.timeouts?.startMs||30000)/1000+' 秒）');})]);
        break;
      }catch(error){
        await client.close().catch(()=>{});
        if(error instanceof UnauthorizedError||error.code==='LOGIN_REQUIRED'){this.stopChild();if(this.oauth)markLogin(this.stateDir,this.id,true);throw Object.assign(Error(this.oauth?LOGIN_MESSAGE:'The server refused the connection (401): check the key in CMCP'),{code:this.oauth?'LOGIN_REQUIRED':undefined});}
        if(!retry||Date.now()>=deadline){this.stopChild();throw error;}
        await delay(500);
      }
    }
    client.onclose=()=>{if(this.client===client)this.dropped();};
    if(this.oauth)markLogin(this.stateDir,this.id,false);
    this.log('connected '+JSON.stringify(client.getServerVersion()||{}));
    return client;
  }
  dropped(){if(this.client){this.client=null;this.state='stopped';this.log('connection closed');if(!this.stopping)this.failures.push(Date.now());}clearTimeout(this.idleTimer);}
  armIdle(){clearTimeout(this.idleTimer);if(this.idleMs>0&&this.manifest.lifecycle!=='persistent'&&this.active===0){this.idleTimer=setTimeout(()=>{if(this.active===0)this.stop('idle').catch(()=>{});},this.idleMs);this.idleTimer.unref?.();}}
  async listUpstream(client){
    const tools=[];let cursor;
    do{const page=await client.listTools(cursor?{cursor}:undefined,{timeout:this.manifest.timeouts?.startMs||30000});tools.push(...page.tools);cursor=page.nextCursor;}while(cursor&&tools.length<2000);
    return tools;
  }
  // Reads tools/list once and keeps it, so later catalogs need no running process.
  async refresh(){
    const client=await this.start();
    try{const tools=await this.listUpstream(client),extras=await this.listExtras(client);const before=JSON.stringify([this.cachedTools(),readToolExtras(this.stateDir,this.id,this.hash)]);writeToolCache(this.stateDir,this.id,this.hash,tools,extras);if(before!==JSON.stringify([tools,extras]))this.onToolsChanged();return tools;}
    finally{this.armIdle();}
  }
  async listExtras(client){
    const caps=client.getServerCapabilities()||{},extras={resources:[],prompts:[]},timeout={timeout:this.manifest.timeouts?.startMs||30000};
    try{if(caps.resources){let cursor;do{const page=await client.listResources(cursor?{cursor}:undefined,timeout);extras.resources.push(...page.resources);cursor=page.nextCursor;}while(cursor&&extras.resources.length<2000);}}catch(error){this.log('resources/list failed: '+error.message);}
    try{if(caps.prompts){let cursor;do{const page=await client.listPrompts(cursor?{cursor}:undefined,timeout);extras.prompts.push(...page.prompts);cursor=page.nextCursor;}while(cursor&&extras.prompts.length<2000);}}catch(error){this.log('prompts/list failed: '+error.message);}
    return extras;
  }
  // Reading a resource or getting a prompt runs on the live process, like a tool call.
  async request(kind,params,ctx={}){
    let client;
    try{client=await this.start();}catch(error){throw Error('Local tool '+this.id+' could not start: '+error.message);}
    await this.acquire();clearTimeout(this.idleTimer);const entry=ctx||{};this.calls.push(entry);
    try{return kind==='resource'?await client.readResource(params,{timeout:this.manifest.timeouts?.callMs||120000}):await client.getPrompt(params,{timeout:this.manifest.timeouts?.callMs||120000});}
    finally{this.calls.splice(this.calls.indexOf(entry),1);this.release();}
  }
  async acquire(){const limit=this.manifest.maxConcurrency||4;if(this.active<limit){this.active++;return;}await new Promise(resolve=>this.waiting.push(resolve));this.active++;}
  release(){this.active--;const next=this.waiting.shift();if(next)next();else this.armIdle();}
  async call(name,args,ctx={}){
    let client;
    try{client=await this.start();}catch(error){return {isError:true,content:[{type:'text',text:'Local tool '+this.id+' could not start: '+error.message}]};}
    await this.acquire();clearTimeout(this.idleTimer);
    const started=Date.now(),entry=ctx||{};this.calls.push(entry);
    try{
      const result=await client.callTool({name,arguments:args},undefined,{timeout:this.manifest.timeouts?.callMs||120000,resetTimeoutOnProgress:true});
      this.log('call '+name+' '+(Date.now()-started)+'ms'+(result.isError?' error':''));
      return result;
    }catch(error){
      this.log('call '+name+' failed after '+(Date.now()-started)+'ms: '+error.message);
      // Rejected before running (bad arguments, unknown tool) is a plain error; anything after
      // the request may have left is reported as an unknown outcome and never resent.
      if(error instanceof McpError&&[ErrorCode.InvalidParams,ErrorCode.MethodNotFound,ErrorCode.InvalidRequest].includes(error.code))return {isError:true,content:[{type:'text',text:error.message}]};
      return {isError:true,content:[{type:'text',text:UNCERTAIN+' ('+error.message+')'}]};
    }finally{this.calls.splice(this.calls.indexOf(entry),1);this.release();}
  }
  stopChild(){if(this.child){try{this.child.kill();}catch{}this.child=null;}}
  async stop(reason='stop'){
    clearTimeout(this.idleTimer);const client=this.client;this.client=null;this.stopping=true;
    try{if(client){this.log('stop ('+reason+')');await client.close().catch(()=>{});}this.stopChild();}finally{this.stopping=false;if(this.state==='running')this.state='stopped';}
  }
  async close(){this.closed=true;await this.stop('close');}
}
