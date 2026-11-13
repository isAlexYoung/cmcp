import {acquireWebTunnel} from '../app/ssh-web.mjs';
import {webTunnelEnvironment} from './ssh.mjs';
import {cloudcliName,recordCloudcliKind} from '../app/cloudcli.mjs';
import {runSetup} from '../app/cloudcli-setup.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ManagerState} from './state.mjs';
import {STATE,VERSION,keychain,proxyFor,atomicWrite,safeFile} from './platform.mjs';
import {createDispatcher} from './dispatcher.mjs';
import {Cloud} from './cloud-api.mjs';
import {agentFor} from '../app/link-client.mjs';
import {requiresSharedSession} from '../app/desktop-auth.mjs';
import {createTargetConnections} from '../app/target-connections.mjs';
import {managedTargetFactory} from '../app/managed-target.mjs';
import {staticAssets} from '../app/static-assets.mjs';
import {checkFailed,checkRelease,downloadUpdate} from './updates.mjs';
import {currentInstallation} from './uninstall.mjs';
import {closeSessions,detectTerminals,openTerminal} from './ssh.mjs';
import {closePages,detectBrowsers,openPage} from './browsers.mjs';
import {stopSshWorker,sshWorkerState,stopSshWorkers,ensureSshWorker} from '../app/ssh-terminal.mjs';
import {status as toolStatus,set as setTools,applySwitches,importText,remove as removeTool} from '../app/mcp-tools-cli.mjs';
import {requestRefresh,toolsRoot,toolLogFile,ID} from '../app/mcp-tools.mjs';
import {marketView,installPreset,updatePreset} from '../app/mcp-market.mjs';
import {spawn} from 'node:child_process';

const resources=path.join(path.dirname(fileURLToPath(import.meta.url)),'ui');
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function createManager({directory=STATE,secrets=keychain,proxy=proxyFor,dispatcher:injected,detectShared,install,installation=currentInstallation(directory),removeCloud,version=VERSION,platform=process.platform,arch=process.arch,launchTerminal=openTerminal,terminals=detectTerminals,channelState=sshWorkerState,stopChannel=stopSshWorker,browsers=detectBrowsers,openBrowserPage=openPage,closeBrowserPages=closePages,closeTerminals=closeSessions,checkUpdate=checkRelease,prepareUpdate=downloadUpdate,startChannel,setupCloudcli=runSetup,toolSecrets}={}){
  const store=new ManagerState(directory,secrets),token=randomBytes(32).toString('hex'),states={};
  const dispatcher=injected||await createDispatcher({roots:store.config.roots,stateDir:directory});
  const machineFile=path.join(directory,'machine-id');safeFile(machineFile);
  let machine;try{machine=fs.readFileSync(machineFile,'utf8').trim();if(!/^[a-f0-9-]{36}$/.test(machine))throw Error();}catch{machine=randomUUID();atomicWrite(machineFile,machine);}
  const status={set(name,state,message){if(state==='password')message='保存的密码不正确或不可用。请停止此连接后编辑密码。';states[name]={state,message,at:new Date().toISOString(),clients:states[name]?.clients};},clients(name,value){if(states[name])states[name].clients=value;}};
  const log=text=>{try{const file=path.join(directory,'service.log');safeFile(file);if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024){safeFile(file+'.1');fs.renameSync(file,file+'.1');}const name=/^\[([a-f0-9-]{36})\] ([a-z-]+)/.exec(text),close=/\bclose=(\d{1,4})\b/.exec(text);const recovery=/\] ((?:web (?:document|api|asset) (?:(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) attempt=[1-5] code=(?:ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE|HTTP_50[234]) tls=(?:true|false)|recovered attempts=[2-5]|cache hit|failed code=NON_TRANSIENT))|heartbeat (?:delayed; retaining connection|recovered without reconnect))$/.exec(text);fs.appendFileSync(file,new Date().toISOString()+' '+(name?name[1]+' '+(recovery?recovery[1]:name[2]):'transport event')+(close?' close='+close[1]:'')+'\n',{mode:0o600});}catch{}};
  const connections=createTargetConnections({readTargets:()=>store.linkTargets(),readControls:()=>store.controlMap(),status,
    create:managedTargetFactory({openTunnel:async(t,signal)=>{const login=store.sshFor(t.tunnel.id);return acquireWebTunnel({directory,id:t.tunnel.id,login,signal,env:webTunnelEnvironment(login,directory)});},proxyFor:proxy,machine,deviceName:os.hostname(),recoveryOptions:{limit:16384},version,forward:dispatcher.forward,catalog:dispatcher.registry,
      askPassword:async()=>false,notify:()=>{},log,passwordFor:id=>store.password(id),onCloudcliKind:(id,kind)=>recordCloudcliKind(directory,id,kind),
      install:install||((target,auth,agent,signal,preparation)=>new Cloud(target.url,auth,agent,signal,preparation).install())})});
  // The device's background SSH channel, as a terminal would start it, but with no window.
  const ensureChannel=startChannel||(login=>ensureSshWorker({directory,id:login.id,owner:process.pid,ssh:'/usr/bin/ssh',env:webTunnelEnvironment(login,directory),progress:()=>{}}));
  const channel=id=>{const login=store.sshFor(id);if(login)Promise.resolve().then(()=>ensureChannel(login)).catch(()=>{});};
  // Per device: checking, confirm (waiting for the user), running, done. Passwords never stay here.
  const setups=new Map();
  const setupView=id=>{const s=setups.get(id);return s?{phase:s.phase,progress:s.progress,plan:s.phase==='confirm'?{summary:s.plan.summary,steps:s.plan.steps,needsPassword:s.plan.needsPassword}:null,result:s.result||null}:{phase:'idle'};};
  async function beginSetup(id){
    const login=store.sshFor(id);if(!login)throw Error('还没有填写 SSH 信息，请编辑设备后再连接。');
    if(['checking','confirm','running'].includes(setups.get(id)?.phase))return setupView(id);
    const s={phase:'checking',progress:'正在通过 SSH 检查 VPS（只读）…'};setups.set(id,s);
    const direct=store.cloudcliFor(id)?.url||'';
    s.task=setupCloudcli({directory,id,login,owner:process.pid,ssh:'/usr/bin/ssh',env:webTunnelEnvironment(login,directory),directUrl:direct,
      progress:message=>{s.progress=message;},
      confirm:plan=>new Promise(resolve=>{s.plan=plan;s.phase='confirm';s.answer=resolve;}),
      save:value=>store.serial(()=>{store.applyCloudcliSetup(id,value);connections.tick();}),
    }).then(result=>{s.result=result;},error=>{s.result={ok:false,message:error.message||'初始化未完成'};}).finally(()=>{s.phase='done';s.answer=null;});
    for(let i=0;i<300&&s.phase==='checking';i++)await delay(100);
    return setupView(id);
  }
  let origin='',closing=false,updates={state:'unchecked',version:null},updating=false,uninstalling=false,checking=null,preparedUpdate=null;
  const devices=()=>{const view=store.view(states);return {...view,targets:view.targets.map(t=>t.ssh?{...t,sshState:channelState(directory,t.id),...setups.has(t.id)?{setup:setups.get(t.id).phase}:{}}:t)};};
  const snapshot=()=>({...devices(),version,platform:'macos-'+arch,updates,terminals:terminals().map(({id,label})=>({id,label})),browsers:browsers().map(({id,label})=>({id,label}))});
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  const readBody=async req=>{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('请求过大');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');};
  const protocol=detectShared|| (async url=>{const agent=agentFor(url,await proxy(url));try{return await requiresSharedSession(url,agent);}finally{agent?.destroy();}});
  const connectionName=id=>store.connectionName(id);
  const browserPreferences=id=>store.loginMode(id)==='cloudcli'?{...store.preferences,browser:store.preferences.cloudcliBrowser||'',closeWeb:store.preferences.closeCloudcli===true}:store.preferences;
  async function entry(id){const name=connectionName(id);if(!store.linkTargets().some(t=>t.name===name))throw Error(store.route(id)==='ssh'?'还没有配置此打开对象的 SSH 隧道，请编辑设备后再连接。':store.loginMode(id)==='cloudcli'?'还没有填写 CloudCLI 地址，请编辑设备后再连接。':'还没有填写网页桌面地址，请编辑设备后再连接。');for(let i=0;i<100;i++){if(closing)throw Error('程序正在退出');const record=connections.values().find(t=>t.name===name);if(record)return record.gateway?.launchUrl||record.url;if(!store.controlMap().get(name)?.enabled)throw Error('请先启动连接');await delay(100);}throw Error('连接尚未准备好，请查看卡片进度');}
  // A running connection already holds a session; otherwise only a saved password can open one.
  const removeCloudConfig=removeCloud||(async target=>{
    const record=connections.values().find(t=>t.name===target.id);
    if(record?.auth)return new Cloud(record.url,record.auth,record.agent).uninstall();
    if(target.authMode==='cloudcli')throw Error('CloudCLI must be connected to remove its cloud configuration');
    const cloud=await Cloud.connect(target.url,await store.password(target.id),await proxy(target.url));
    try{await cloud.uninstall();}finally{cloud.close();}
  });
  async function uninstallApplication(appPid){
    installation.check();
    const cleanupTargets=[...store.targets,...store.linkTargets().filter(t=>t.authMode==='cloudcli').map(t=>({...t,id:t.name}))];
    const cloudFailed=(await Promise.all(cleanupTargets.map(target=>Promise.race([removeCloudConfig(target),delay(45000,undefined,{ref:false}).then(()=>{throw Error('Cloud removal timed out');})]).then(()=>0,()=>1)))).reduce((sum,failed)=>sum+failed,0);
    await store.serial(()=>store.setEnabled(null,false));
    await Promise.allSettled(store.targets.map(t=>{const ref=t.credentialId||(!t.authMode?t.id:null);return ref?secrets('delete',ref):null;}));
    await Promise.allSettled([...store.ssh.logins,...store.cloudcli.logins].flatMap(l=>[l.credentialId,l.webCredentialId,l.cloudcliCredentialId].filter(Boolean).map(ref=>secrets('delete',ref))));
    installation.launch([process.pid,process.ppid,appPid]);
    return {uninstalled:true,cloudFailed};
  }
  async function close({disable=false}={}){if(closing)return;closing=true;if(disable)await store.serial(()=>store.setEnabled(null,false));clearInterval(publish);await Promise.all([connections.close(),stopSshWorkers(directory)]);staticAssets.clear();await dispatcher.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
  const routes={
    '/api/state':async()=>snapshot(),
    '/api/tray':async()=>({targets:store.view(states).targets.map(t=>{const v=t.route==='ssh'&&t.loginMode!=='ssh'?t.tunnels[t.loginMode]:t.loginMode==='cloudcli'?t.cloudcli:t;return {id:t.id,label:t.label,state:v?.state||'stopped',enabled:v?.enabled===true,loginMode:t.loginMode,...t.loginMode==='ssh'?{ssh:true}:{}};}),language:store.preferences.language,updating}),
    '/api/targets/save':input=>store.serial(async()=>({id:await store.save(input,protocol)})),
    '/api/targets/start':input=>store.serial(()=>{if(typeof input.id!=='string')throw Error('请选择连接');store.setEnabled(input.id,true);connections.tick();if(store.loginMode(input.id)==='cloudcli'&&store.autoChannel(input.id))channel(input.id);return {started:true};}),
    // The page window closes after the stop is saved; that never holds up the reply.
    '/api/targets/stop':async input=>{const result=await store.serial(()=>{if(typeof input.id!=='string')throw Error('请选择连接');store.setEnabled(input.id,false);connections.tick();return {stopped:true};});closeBrowserPages(browserPreferences(input.id),directory,connectionName(input.id)).catch(()=>{});return result;},
    '/api/targets/delete':input=>store.serial(async()=>{await store.remove(input.id);connections.tick();return {deleted:true};}),
    '/api/targets/order':input=>store.serial(()=>{store.reorder(input.ids);return {saved:true};}),
    // opened:false leaves the page to the system default browser, which the native host opens.
    '/api/targets/open':async input=>{const url=await entry(input.id);let opened=false;try{opened=await openBrowserPage(browserPreferences(input.id),directory,connectionName(input.id),url);}catch{}return {url,opened};},
    '/api/targets/ssh-stop':async input=>{if(!store.sshFor(input.id))throw Error('连接不存在');const close=store.preferences.closeTerminal===true;if(close)await closeTerminals(directory,input.id).catch(()=>0);await stopChannel(directory,input.id);return {stopped:true,closedTerminals:close};},
    '/api/targets/route':input=>store.serial(()=>{store.setRoute(input.id,input.route);return {saved:true};}),
    '/api/targets/login':input=>store.serial(()=>{store.setLogin(input.id,input.mode??input.active);return {saved:true};}),
    '/api/targets/terminal':async input=>{const login=store.sshFor(input.id);if(!login)throw Error(store.targets.some(t=>t.id===input.id)?'还没有填写 SSH 信息，请编辑设备后再连接。':'连接不存在');return {terminal:await launchTerminal(login,directory,store.preferences.terminal,{closeTerminal:store.preferences.closeTerminal===true})};},
    '/api/targets/cloudcli-setup':input=>{if(typeof input.id!=='string')throw Error('请选择连接');return beginSetup(input.id);},
    '/api/targets/cloudcli-setup/status':async input=>setupView(input.id),
    // The sudo password goes straight into this run and is not kept once it has been handed on.
    '/api/targets/cloudcli-setup/answer':async input=>{const s=setups.get(input.id);if(s?.phase!=='confirm'||!s.answer)throw Error('没有等待确认的初始化');if(input.password!==undefined&&(typeof input.password!=='string'||input.password.length>1024))throw Error('密码无效');const answer=s.answer;s.answer=null;s.phase=input.ok===true?'running':'checking';answer({ok:input.ok===true,password:input.password});return setupView(input.id);},
    '/api/settings':input=>store.serial(()=>{store.settings(input);return {saved:true};}),
    // Settings > Tools: one set of switches for this Mac, shared by every connection.
    '/api/tools':async()=>toolStatus(directory),
    '/api/tools/set':async input=>{setTools(directory,{group:input.group,tool:input.tool,on:input.on===true,idle:input.idle,'blender-offer-done':input.blenderOfferDone===true});return {saved:true};},
    '/api/tools/apply':async input=>{const s=applySwitches(directory,{groups:input.groups||{},tools:input.tools||{}});return {saved:true,groups:s.groups,tools:s.tools};},
    // Settings > Market: reviewed presets; install writes the tool folder, update needs a confirmation.
    '/api/market':async()=>({presets:marketView(directory)}),
    '/api/market/install':async input=>{const r=installPreset(directory,input.id);requestRefresh(directory);return r;},
    '/api/market/update':async input=>{const r=updatePreset(directory,input.id,{confirmed:input.confirmed===true});requestRefresh(directory);return r;},
    '/api/tools/refresh':async()=>{requestRefresh(directory);return {refreshed:true};},
    '/api/tools/import':async input=>{if(typeof input.text!=='string'||input.text.length>256*1024)throw Error('粘贴的内容无效');return importText(directory,input.text,{apply:input.apply===true,...toolSecrets?{secrets:toolSecrets}:{}});},
    '/api/tools/remove':input=>removeTool(directory,input.id),
    '/api/tools/open':async input=>{
      const target=input.what==='folder'?toolsRoot(directory):typeof input.id==='string'&&ID.test(input.id)?toolLogFile(directory,input.id):null;
      if(!target||!fs.existsSync(target))throw Error(input.what==='folder'?'mcp-tools 文件夹不存在':'这个工具还没有日志。');
      spawn('/usr/bin/open',input.what==='folder'?[target]:['-t',target],{stdio:'ignore',detached:true}).on('error',()=>{}).unref();return {opened:true};
    },
    '/api/update/check':async()=>{
      if(updating)return updates;if(checking)return checking;
      checking=(async()=>{try{
        const release=await checkUpdate(version,arch,await proxy('https://api.github.com'));
        if(release&&preparedUpdate?.version===release.version)updates={state:'ready',phase:'ready',version:release.version,received:1,total:1};
        else{preparedUpdate=null;updates={state:release?'available':'latest',version:release?.version||null};}
      }catch{updates=checkFailed(updates);}return updates;})();
      try{return await checking;}finally{checking=null;}
    },
    '/api/update/download':async()=>{if(updating||checking)throw Error('更新正在进行');updating=true;try{
      preparedUpdate=await prepareUpdate({current:version,arch,proxy:await proxy('https://api.github.com'),directory,onProgress:value=>{updates={state:'updating',version:updates.version,...value};}});
      updates={state:'ready',phase:'ready',version:preparedUpdate.version,received:1,total:1};return {directory:preparedUpdate};
    }catch(error){updates={state:'failed',version:updates.version,code:error.code||'prepare',phase:error.phase||'release'};throw error;}finally{updating=false;}},
    '/api/update/prepared':async()=>{if(updating||checking||updates.state!=='ready'||!preparedUpdate)throw Error('请先下载并校验更新');return {directory:preparedUpdate};},
  };
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(origin).host)return json(res,421,{error:'Host not allowed'});
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&['/','/ui/app.js','/ui/motion.js','/ui/update-state.js','/ui/tooltips.js','/ui/tool-saver.js','/ui/style.css'].includes(url.pathname)){
        const file=url.pathname==='/'?'index.html':url.pathname.split('/').at(-1);
        res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store',
          'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});
        return res.end(fs.readFileSync(path.join(resources,file)));
      }
      if(!equal(req.headers['x-cmcp-token'],token))return json(res,403,{error:'Authorization required'});
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Origin not allowed'});
      if(req.method!=='POST'&&!(req.method==='GET'&&url.pathname==='/api/state'))return json(res,405,{error:'Method not allowed'});
      if(req.method==='POST'&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'JSON required'});
      if(url.pathname==='/api/exit'||url.pathname==='/api/restart'){
        if(req.method!=='POST')return json(res,405,{error:'POST required'});
        if(url.pathname==='/api/exit')await store.serial(()=>store.setEnabled(null,false));
        json(res,200,{stopped:true});setImmediate(()=>close().catch(()=>{}));return;
      }
      if(url.pathname==='/api/uninstall'){
        if(closing||uninstalling)return json(res,503,{error:'程序正在退出'});
        uninstalling=true;
        try{json(res,200,await uninstallApplication((await readBody(req)).appPid));}finally{uninstalling=false;}
        setImmediate(()=>close().catch(()=>{}));return;
      }
      const route=routes[url.pathname];if(!route)return json(res,404,{error:'Not found'});
      const body=req.method==='POST'?await readBody(req):{};
      if(closing)return json(res,503,{error:'程序正在退出'});
      return json(res,200,await route(body));
    }catch(error){return json(res,400,{error:String(error.message||'操作失败').slice(0,300)});}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  origin='http://127.0.0.1:'+server.address().port;
  for(const login of store.ssh.logins)if(store.autoChannel(login.id))channel(login.id);
  const publish=setInterval(()=>{try{atomicWrite(path.join(directory,'status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),targets:states}));}catch{}},2000);publish.unref();
  return {origin,token,url:origin+'/#'+token,store,connections,snapshot,close};
}
