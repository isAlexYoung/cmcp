import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {createTargetConnections, readTargetControls} from '../target-connections.mjs';
import {managedTargetFactory} from '../managed-target.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
import {Cloud} from '../cloud-connector.mjs';

async function until(check, timeout=10000) {
  const end=Date.now()+timeout;
  while (!check()) { if (Date.now()>end) throw Error('condition timeout'); await delay(15); }
}
function board() { return {data:new Map(), set(name,state,message,revision) { this.data.set(name,{state,message,revision}); }}; }
function controls(...names) { return new Map(names.map(name=>[name,{name,enabled:true,revision:name+'-1'}])); }
async function desktop(t) {
  const state={session:'',logins:0,upgrades:0,sockets:[],requests:0,setups:0};
  const server=http.createServer(async(req,res)=>{
    state.requests++;
    const chunks=[]; for await (const c of req) chunks.push(c);
    res.setHeader('content-type','application/json');
    if (req.url==='/api/auth/login') {
      state.logins++; state.session=randomBytes(24).toString('hex');
      res.setHeader('set-cookie','wd_session=test-only; Path=/; HttpOnly; Secure; SameSite=Strict');
      return res.end(JSON.stringify({sessionId:state.session}));
    }
    if (req.url==='/api/auth/session') {
      const ok=state.session && req.headers['x-desktop-session']===state.session && req.headers.cookie==='wd_session=test-only';
      res.writeHead(ok?200:401);return res.end(JSON.stringify(ok?{ok:true}:{error:'其他设备已登录'}));
    }
    if (req.url.startsWith('/api/sys/info')) return res.end('{"home":"/home/fixture"}');
    if (req.url.startsWith('/api/sys/fs')) return res.end('{"entries":[]}');
    res.end('{"ok":true}');
  });
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    const u=new URL(req.url,'http://fixture');
    if (u.searchParams.get('access')!==state.session || req.headers.cookie!=='wd_session=test-only') return socket.destroy();
    wss.handleUpgrade(req,socket,head,ws=>{
      if (u.pathname==='/api/term/ws') {
        state.setups++;
        ws.send(Buffer.from('Connected: 99 Windows tools\nConfig changed: 0\n'));
        ws.send(JSON.stringify({t:'exit',code:0})); return;
      }
      state.upgrades++; state.sockets.push(ws);
      ws.on('message',raw=>{
        const m=JSON.parse(raw);
        if (m.t==='hello') ws.send(JSON.stringify({t:'welcome'}));
        else if (m.t==='res') state.reply=m;
      });
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{for(const ws of wss.clients) ws.terminate(); await new Promise(r=>wss.close(r)); server.closeAllConnections(); await new Promise(r=>server.close(r));});
  return {url:`http://127.0.0.1:${server.address().port}`, state};
}
async function signIn(gateway) {
  const origin=gateway.localOrigin || new URL(gateway.launchUrl).origin;
  const claim=await requestBuffered(origin+'/__mcp/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(gateway.launchUrl).hash.slice(1)})});
  assert.equal(claim.status,204);
  const cookie=claim.headers['set-cookie'][0].split(';')[0];
  const login=await requestBuffered(origin+'/api/auth/login',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:'{"password":"test-only"}'});
  assert.equal(login.status,200);
}

test('two independent shared desktops: start/stop/restart A preserves B socket, session, gateway and MCP traffic', {timeout:18000}, async t=>{
  const a=await desktop(t), b=await desktop(t), status=board();
  let desired=controls('A');
  const targets=[{name:'A',url:a.url,authMode:'shared-browser'},{name:'B',url:b.url,authMode:'shared-browser'}];
  const manager=createTargetConnections({readTargets:()=>targets,readControls:()=>desired,status,interval:20,
    create:managedTargetFactory({proxyFor:async()=>'',machine:'fixture',version:'test',
      forward:async msg=>({id:msg.id,result:'local-tool-ok'}),askPassword:()=>assert.fail('no password prompt'),passwordFor:()=>assert.fail('no saved password'),notify:()=>{},log:()=>{}})});
  t.after(()=>manager.close());
  await until(()=>manager.values().length===1);
  assert.equal(b.state.requests,0); assert.equal(b.state.upgrades,0);
  await signIn(manager.values()[0].gateway);
  await until(()=>status.data.get('A')?.state==='connected' && a.state.setups===1);
  const firstA=a.state.sockets[0];
  desired.set('B',{name:'B',enabled:true,revision:'B-1'});
  await until(()=>manager.values().length===2);
  const bGate=manager.values().find(x=>x.name==='B').gateway;
  await signIn(bGate);
  await until(()=>status.data.get('B')?.state==='connected' && b.state.setups===1);
  const socketB=b.state.sockets[0], sessionB=bGate.getSessionId(), launchB=bGate.launchUrl;
  assert.equal(a.state.sockets[0],firstA); assert.equal(a.state.upgrades,1); assert.equal(a.state.logins,1);
  desired.set('A',{name:'A',enabled:false,revision:'A-stop'});
  await until(()=>firstA.readyState===3 && manager.values().length===1);
  assert.equal(status.data.get('A').state,'stopped');
  assert.equal(bGate.getSessionId(),sessionB); assert.equal(bGate.launchUrl,launchB);
  assert.equal(socketB.readyState,1); assert.equal(b.state.logins,1); assert.equal(b.state.upgrades,1);
  socketB.send(JSON.stringify({t:'req',id:'after-stop-A',msg:{id:7,method:'tools/list'}}));
  await until(()=>b.state.reply?.id==='after-stop-A'); assert.equal(b.state.reply.msg.result,'local-tool-ok');
  desired.set('A',{name:'A',enabled:true,revision:'A-2'});
  await until(()=>manager.values().length===2);
  const secondGate=manager.values().find(x=>x.name==='A').gateway;
  await signIn(secondGate);
  await until(()=>a.state.upgrades===2 && status.data.get('A')?.state==='connected');
  assert.equal(b.state.upgrades,1); assert.equal(b.state.logins,1); assert.equal(socketB.readyState,1);
  desired.set('B',{name:'B',enabled:false,revision:'B-stop'});
  await until(()=>socketB.readyState===3);
  assert.equal(a.state.sockets[1].readyState,1);
});

test('slow A creation does not block B or allow stopped A to resurrect; one pending slot per target', {timeout:5000}, async t=>{
  let release, callsA=0, stopsA=0;
  const held=new Promise(r=>release=r), status=board(); let desired=controls('A','B');
  const manager=createTargetConnections({readTargets:()=>[{name:'A',url:'https://a.invalid'},{name:'B',url:'https://b.invalid'}],readControls:()=>desired,status,interval:10,
    create:async(t,ctx)=>{if(t.name==='A'){callsA++;await held;ctx.status.set('A','connected');}return {name:t.name,stop:()=>{if(t.name==='A')stopsA++;}};}});
  t.after(()=>manager.close());
  await until(()=>manager.values().some(v=>v.name==='B'));
  desired=controls('B'); await delay(50);
  for(let i=0;i<8;i++){desired.set('A',{name:'A',enabled:true,revision:String(i)});manager.tick();desired.delete('A');manager.tick();}
  assert.equal(callsA,1);
  release(); await until(()=>stopsA===1);
  assert.notEqual(status.data.get('A')?.state,'connected');
  assert.deepEqual(manager.values().map(v=>v.name),['B']);
});

test('corrupt/oversized/duplicate controls fail closed; restart only recreates explicitly enabled targets', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-controls-')),file=path.join(dir,'controls.json');
  t.after(()=>{fs.rmSync(file,{force:true});fs.rmdirSync(dir);});
  assert.equal(readTargetControls(file).size,0);
  for(const body of ['{','{"schema":1,"targets":{}}',JSON.stringify({schema:1,targets:Array(101).fill({name:'A',enabled:true,revision:'x'})}),' '.repeat(262145),JSON.stringify({schema:1,targets:[{name:'A',enabled:true,revision:'1'},{name:'A',enabled:true,revision:'2'}]})]){
    fs.writeFileSync(file,body);assert.equal(readTargetControls(file).size,0);
  }
  fs.writeFileSync(file,JSON.stringify({schema:1,targets:[{name:'A',enabled:false,revision:'1'},{name:'B',enabled:true,revision:'2'}]}));
  for(let i=0;i<2;i++){
    const manager=createTargetConnections({readTargets:()=>[{name:'A',url:'https://a.invalid'},{name:'B',url:'https://b.invalid'},{name:'new',url:'https://new.invalid'}],readControls:()=>readTargetControls(file),status:board(),create:async t=>({name:t.name,stop(){}})});
    await until(()=>manager.values().length===1);assert.equal(manager.values()[0].name,'B');await manager.close();
  }
});

test('stopping during cloud setup aborts only its HTTP request and setup WebSocket', {timeout:5000}, async t=>{
  let pending=0;
  const server=http.createServer((req,res)=>{pending++;req.on('close',()=>pending--);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const wss=new WebSocketServer({server});let socket;
  wss.on('connection',ws=>{socket=ws;});
  t.after(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const control=new AbortController(),cloud=new Cloud(url,'wd_session=test-only',undefined,control.signal);
  const httpCall=cloud.api('/api/sys/info');const rejection=assert.rejects(httpCall);
  await until(()=>pending===1);control.abort();await rejection;await until(()=>pending===0);
  const second=new AbortController(),cmd=new Cloud(url,'wd_session=test-only',undefined,second.signal).command('fixture-only','/home/fixture');
  const commandRejected=assert.rejects(cmd);
  await until(()=>socket?.readyState===1);second.abort();await commandRejected;await until(()=>socket.readyState===3);
});

for (const phase of ['protocol probe','legacy login']) {
  test(`stop A aborts a pending ${phase} without affecting B`, {timeout:5000}, async t=>{
    let pending=0;
    const server=http.createServer((req,res)=>{
      req.resume();
      if (phase==='protocol probe' || req.url==='/api/auth/login') {
        pending++;res.once('close',()=>pending--);return;
      }
      res.writeHead(404);res.end();
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
    let desired=controls('A','B');
    const factory=managedTargetFactory({proxyFor:async()=>'',machine:'test',version:'test',forward:async()=>null,passwordFor:async()=>'test-only',askPassword:()=>assert.fail('stopped login cannot prompt'),notify:()=>{},log:()=>{}});
    let bStops=0;
    const manager=createTargetConnections({readTargets:()=>[{name:'A',url:`http://127.0.0.1:${server.address().port}`},{name:'B',url:'https://b.invalid'}],readControls:()=>desired,status:board(),interval:10,
      create:(target,context)=>target.name==='A'?factory(target,context):Promise.resolve({name:'B',stop(){bStops++;}})});
    t.after(()=>manager.close());
    await until(()=>pending===1 && manager.values().some(x=>x.name==='B'));
    const b=manager.values().find(x=>x.name==='B');
    desired=controls('B');manager.tick();
    await until(()=>pending===0);
    assert.equal(bStops,0);assert.equal(manager.values().find(x=>x.name==='B'),b);
    assert.ok(!manager.values().some(x=>x.name==='A'));
  });
}

test('real server process honors target switches without changing backend PID or the other desktop', {timeout:40000}, async t=>{
  const a=await desktop(t),b=await desktop(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-multi-server-')),state=path.join(dir,'ClaudeLocalMcp');fs.mkdirSync(state);
  const write=(name,data)=>{const file=path.join(state,name);fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);};
  write('config.json',{token:randomBytes(32).toString('hex'),roots:[dir]});
  write('cloudpc-targets.json',[{name:'A',url:a.url,authMode:'shared-browser'},{name:'B',url:b.url,authMode:'shared-browser'}]);
  const enable=(aa,bb)=>write('target-controls.json',{schema:1,targets:[{name:'A',enabled:aa,revision:aa?'A-on':'A-off'},{name:'B',enabled:bb,revision:'B-on'}]});
  enable(true,false);
  const env={...process.env,LOCALAPPDATA:dir};for(const name of ['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy']) delete env[name];
  const child=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',c=>error+=c.toString().slice(0,2000));
  const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(state,name)));}catch{return null;}};
  t.after(async()=>{
    fs.writeFileSync(path.join(state,'stopped.flag'),'test shutdown');
    if(child.exitCode===null)await Promise.race([once(child,'exit'),delay(7000)]);
    if(child.exitCode===null){child.kill();await once(child,'exit');}
    // This entire freshly-created directory belongs to this test, not user state.
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});
  });
  await until(()=>read('browser-entries.json')?.targets.length===1,20000);
  assert.equal(b.state.requests,0);
  const pid=read('browser-entries.json').pid;
  assert.equal(pid,child.pid,error);
  await signIn(read('browser-entries.json').targets[0]);
  await until(()=>a.state.setups===1);
  enable(true,true);
  await until(()=>read('browser-entries.json')?.targets.length===2,15000);
  await signIn(read('browser-entries.json').targets.find(x=>x.name==='B'));
  await until(()=>b.state.setups===1);
  const socketB=b.state.sockets[0],sessionB=b.state.session;
  enable(false,true);
  await until(()=>read('link-status.json')?.targets.A?.state==='stopped' && a.state.sockets[0].readyState===3);
  assert.equal(read('browser-entries.json').pid,pid);assert.equal(b.state.upgrades,1);assert.equal(b.state.session,sessionB);
  socketB.send(JSON.stringify({t:'req',id:'B-survives',msg:{jsonrpc:'2.0',id:88,method:'tools/list'}}));
  await until(()=>b.state.reply?.id==='B-survives');
  assert.ok(b.state.reply.msg.result.tools.some(x=>x.name==='read_file'));
  assert.equal(b.state.logins,1);assert.equal(child.exitCode,null);
});
