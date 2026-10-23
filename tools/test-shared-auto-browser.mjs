// Real disposable Chrome/Edge, loopback desktops and production target factory.
// No default browser profile, real VPS, startup settings or personal state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {managedTargetFactory} from '../app/managed-target.mjs';
import {createTargetConnections} from '../app/target-connections.mjs';
const {WebSocket,WebSocketServer}=createRequire(new URL('../app/package.json',import.meta.url))('ws');
const evidence=path.resolve(process.argv[2]||'build-results/shared-auto-browser');fs.mkdirSync(evidence,{recursive:true});
const checks=[],errors=[];
const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);};
async function until(condition,ms=15000){const end=Date.now()+ms;while(!await condition()){if(Date.now()>end)throw Error('Timed out waiting for browser fixture');await delay(40);}}
const html='<!doctype html><html><head><meta charset="utf-8"><script nonce="fixtureAutoNonce123" defer src="/login-fixture.js"></script></head><body><h1>CMCP test desktop</h1><form><input type="password" autocomplete="current-password" disabled><button type="submit" disabled>解锁并接管桌面</button><p id="error"></p></form></body></html>';
// An own value tracker reproduces controlled-input behaviour: assigning .value
// directly is ignored, using the native setter + input event updates the state.
const formScript=`const field=document.querySelector('input'),button=document.querySelector('button');
const native=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');let tracked='',state='';
Object.defineProperty(field,'value',{get(){return native.get.call(this)},set(v){tracked=String(v);native.set.call(this,v)}});
field.addEventListener('input',()=>{const value=native.get.call(field);if(value!==tracked){state=value;tracked=value;button.disabled=!state;}});
setTimeout(()=>{field.disabled=false},120);
document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;
const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:state})});const result=await r.json();
if(r.ok&&result.sessionId){window.fixtureSession=result.sessionId;const valid=await fetch('/api/auth/session',{headers:{'X-Desktop-Session':result.sessionId}});if(valid.ok){document.body.innerHTML='<h1>已自动登录测试桌面</h1>';document.body.dataset.ready='true';}}
else{document.querySelector('#error').textContent=result.error||'失败';field.value='';state='';button.disabled=true;}});`;
const servers=[];
async function desktop(password){
  const s={posts:0,upgrades:0,session:'',sockets:[]};
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'nonce-fixtureAutoNonce123'; connect-src 'self'"});return res.end(html);}
    if(req.url==='/login-fixture.js'){res.writeHead(200,{'content-type':'application/javascript'});return res.end(formScript);}
    const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');
    if(req.url==='/api/auth/login'){
      s.posts++;if(JSON.parse(Buffer.concat(chunks)).password!==password){res.writeHead(401);return res.end('{"error":"wrong"}');}
      s.session='browser-fixture-session-'+s.posts+'-12345678';res.setHeader('set-cookie','wd_session=fixture-dual; HttpOnly; Secure');return res.end(JSON.stringify({sessionId:s.session}));
    }
    const ok=req.headers['x-desktop-session']===s.session&&req.headers.cookie==='wd_session=fixture-dual';res.writeHead(ok?200:401);res.end(JSON.stringify(ok?{ok:true}:{error:'其他设备已登录'}));
  });
  const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{
    if(req.headers.cookie!=='wd_session=fixture-dual'||new URL(req.url,'http://test').searchParams.get('access')!==s.session)return socket.destroy();
    wss.handleUpgrade(req,socket,head,ws=>{s.upgrades++;s.sockets.push(ws);ws.on('message',raw=>{if(JSON.parse(raw).t==='hello')ws.send('{"t":"welcome"}');});});
  });server.listen(0,'127.0.0.1');await once(server,'listening');servers.push({server,wss});return {url:`http://127.0.0.1:${server.address().port}`,s};
}
let browser,cdp,manager,stage='fixture setup',failureSnapshot;const profile=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-auto-browser-'));
try{
  const a=await desktop('正确 密码 A1'),b=await desktop('right-B');
  const states=new Map(),reads={A:0,B:0};const desired=new Map(['A','B'].map(name=>[name,{enabled:true,revision:name+'1'}]));
  const targets=[{name:'A',url:a.url,authMode:'shared-browser',autoLogin:true},{name:'B',url:b.url,authMode:'shared-browser',autoLogin:true}];
  manager=createTargetConnections({readTargets:()=>targets,readControls:()=>desired,interval:20,status:{set:(name,state,message)=>states.set(name,{state,message})},
    create:managedTargetFactory({proxyFor:async()=>'',machine:'fixture',version:'test',forward:async()=>null,askPassword:()=>{throw Error('Unexpected password popup')},notify:()=>{},log:()=>{},install:async()=>false,
      passwordFor:async name=>{reads[name]++;return name==='A'?'正确 密码 A1':'wrong-B';}})});
  await until(()=>manager.values().length===2);check(a.s.posts===0&&b.s.posts===0,'no automatic login before an authorized browser opens the page');
  const executable=[process.env.CMCP_TEST_BROWSER,path.join(process.env.ProgramFiles||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe')].find(p=>p&&fs.existsSync(p));
  if(!executable)throw Error('Required real Chrome/Edge executable is unavailable');
  stage='browser startup';
  browser=spawn(executable,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-component-update','--window-size=1100,720','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  browser.stderr.pipe(fs.createWriteStream(path.join(evidence,'browser.stderr.txt')));
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')));
  const [port,wsPath]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
  cdp=new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);cdp.on('error',()=>{});await once(cdp,'open');let serial=0;const waiting=new Map();
  cdp.on('message',data=>{const msg=JSON.parse(data);if(msg.id){const w=waiting.get(msg.id);if(w){waiting.delete(msg.id);clearTimeout(w.timer);msg.error?w.reject(Error(msg.error.message)):w.resolve(msg.result);}}else if(msg.method==='Runtime.exceptionThrown')errors.push('browser exception');});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{waiting.delete(id);reject(Error('CDP command timeout: '+method))},15000);waiting.set(id,{resolve,reject,timer});cdp.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});
  async function page(url){const {targetId}=await send('Target.createTarget',{url});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);return sessionId;}
  async function evaluate(session,expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error('Fixture browser evaluation failed');return r.result.value;}
  const gateA=()=>manager.values().find(v=>v.name==='A').gateway;
  stage='first automatic browser login';
  const pageA=await page(gateA().launchUrl);
  failureSnapshot=async()=>({states:Object.fromEntries(states),reads,posts:{A:a.s.posts,B:b.s.posts},upgrades:{A:a.s.upgrades,B:b.s.upgrades},page:await evaluate(pageA,`({ready:document.readyState,desktop:document.body?.dataset.ready==='true',passwordFields:document.querySelectorAll('input[type="password"]').length,fieldDisabled:document.querySelector('input')?.disabled,hasPlaceholder:document.querySelector('input')?.value.startsWith('cmcp-auto-'),buttonDisabled:document.querySelector('button')?.disabled,scripts:[...document.scripts].map(s=>new URL(s.src,location.href).pathname)})`)});
  await until(async()=>states.get('A')?.state==='connected'&&await evaluate(pageA,"document.body.dataset.ready==='true'"));
  check(a.s.posts===1&&reads.A===1,'real browser controlled unlock form auto-submits exactly once');
  check(await evaluate(pageA,'window.fixtureSession')===gateA().getSessionId(),'browser and production MCP target share the same session and HTTP cookie');
  check(b.s.posts===0&&reads.B===0,'A browser login does not decrypt or log in B');
  const shot=await send('Page.captureScreenshot',{format:'png'},pageA);fs.writeFileSync(path.join(evidence,'automatic-success.png'),Buffer.from(shot.data,'base64'));
  a.s.sockets[0].terminate();await until(()=>a.s.upgrades>=2);check(a.s.posts===1&&reads.A===1,'MCP socket reconnect does not submit saved password again');
  const gateB=manager.values().find(v=>v.name==='B').gateway;const pageB=await page(gateB.launchUrl);
  await until(()=>states.get('B')?.state==='password');
  check(b.s.posts===1&&reads.B===1&&a.s.sockets.at(-1).readyState===1,'wrong B password stops automatic attempts and leaves A connected');
  await send('Page.reload',{},pageB);await delay(800);check(b.s.posts===1&&reads.B===1,'refresh after wrong password does not retry or lock the desktop');
  desired.set('A',{enabled:false,revision:'A-stop'});await until(()=>states.get('A')?.state==='stopped');check(desired.get('B').enabled&&b.s.posts===1,'selected stop preserves B control and does not retry its rejected password');
  desired.set('A',{enabled:true,revision:'A2'});await until(()=>manager.values().find(v=>v.name==='A')?.gateway);
  const second=await page(gateA().launchUrl);await until(async()=>states.get('A')?.state==='connected'&&await evaluate(second,"document.body.dataset.ready==='true'"));
  check(a.s.posts===2&&reads.A===2,'explicit stop and new start permit one new automatic login');
  check(errors.length===0,'browser fixture completes without JavaScript exceptions');
  await send('Browser.close');
  const result={passed:checks.length,failed:0,skipped:0,checks,environment:{browser:path.basename(executable),node:process.version},not_executed:['real VPS and its exact frontend build']};
  fs.writeFileSync(path.join(evidence,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){let diagnostics;try{diagnostics=await failureSnapshot?.();}catch{diagnostics={snapshotUnavailable:true};}const result={passed:checks.length,failed:1,skipped:0,checks,error:error.message,stage,browserExitCode:browser?.exitCode,diagnostics};fs.writeFileSync(path.join(evidence,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=1;}
finally{
  cdp?.close();await manager?.close();
  for(const {server,wss} of servers){for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));}
  if(browser&&browser.exitCode===null){const exited=once(browser,'exit');await Promise.race([exited,delay(3000)]);if(browser.exitCode===null)browser.kill();}
  // Leave the isolated profile as evidence; never recursively delete a computed path.
}
