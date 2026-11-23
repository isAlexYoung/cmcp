import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {startClaudewebMcp} from '../claudeweb-mcp.mjs';
import {discoverCloudcli} from '../cloudcli.mjs';

const until=async(predicate)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Bridge did not settle');};
async function fixture(t,{refuse=false}={}){
  const calls=[],sockets=new Set();let bootstrap=null;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    calls.push({path:req.url,body:raw,authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    if(refuse&&req.url==='/api/auth/cmcp/code'){res.statusCode=401;return res.end(JSON.stringify({error:{code:'AUTH_INVALID_PASSWORD'}}));}
    const values={'/api/auth/cmcp':{protocol:'claudeweb-cmcp',version:1,capabilities:{webMcp:1}},'/api/auth/cmcp/code':{code:'one-use-code'},'/api/auth/cmcp/redeem':{token:'private-session'},'/api/auth/cmcp/session-code':{code:'browser-code'},'/api/auth/logout':{success:true}};
    res.end(JSON.stringify(values[req.url]||{}));
  });
  const wss=new WebSocketServer({server});
  wss.on('connection',(socket,request)=>{
    sockets.add(socket);assert.equal(request.url,'/cmcp-ws');assert.equal(request.headers.authorization,'Bearer private-session');
    const frame=message=>socket.send(Buffer.from('CPCMCP1:'+Buffer.from(JSON.stringify(message)).toString('base64')+'\n'),{binary:true});
    let pending='';
    socket.on('message',raw=>{
      const message=JSON.parse(raw);
      if(message.t==='bootstrap'){bootstrap=message.data;frame({t:'ready'});return;}
      if(message.t==='kill'){socket.close();return;}
      const packet=JSON.parse(message.d.trim().slice('CPCMCP1:'.length));
      if(packet.t==='ping'){frame({t:'pong',nonce:packet.nonce});return;}
      pending+=packet.data;frame({t:'ack',id:packet.id,n:packet.n});
      if(packet.end){const value=JSON.parse(Buffer.from(pending,'base64'));pending='';if(value.t==='hello')frame({t:'welcome'});}
    });
    socket.on('close',()=>sockets.delete(socket));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.terminate();wss.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {url:'http://127.0.0.1:'+server.address().port,calls,get bootstrap(){return bootstrap;}};
}
const catalog={list:()=>({tools:[],instructions:'PC tools'}),revision:()=>1,on:()=>()=>{}};

test('standalone discovery opts into the web MCP bridge without changing its login protocol',async t=>{
  const cloud=await fixture(t);
  assert.deepEqual(await discoverCloudcli(cloud.url),{origin:cloud.url,kind:'claudeweb',webMcp:true});
});

test('URL bridge authenticates, registers the platform connector, reuses browser session and signs itself out',async t=>{
  const cloud=await fixture(t),controller=new AbortController(),states=[];
  const bridge=startClaudewebMcp({url:cloud.url,passwordFor:async()=>'saved-password',machine:'fixture',catalog,forward:async()=>({}),signal:controller.signal,status:(state,message)=>states.push([state,message])});
  t.after(()=>bridge.stop());
  assert.equal(await bridge.browserCode(),'browser-code');
  await until(()=>states.some(([state])=>state==='connected'));
  assert.match(cloud.bootstrap.name,/^(windows|linux|mac)-pc-files$/);
  assert.match(cloud.bootstrap.connector,/def apply_install/);assert.match(cloud.bootstrap.relay,/class Relay/);
  assert.deepEqual(JSON.parse(cloud.calls.find(call=>call.path==='/api/auth/cmcp/redeem').body),{code:'one-use-code',mode:'join'});
  assert.equal(cloud.calls.find(call=>call.path==='/api/auth/cmcp/session-code').authorization,'Bearer private-session');
  assert.ok(states.every(([,message])=>!message.includes('SSH')));
  await bridge.stop();
  assert.equal(cloud.calls.at(-1).path,'/api/auth/logout');assert.equal(cloud.calls.at(-1).authorization,'Bearer private-session');
});

test('a refused password never opens a relay or claims that PC tools are connected',async t=>{
  const cloud=await fixture(t,{refuse:true}),controller=new AbortController(),states=[];
  const bridge=startClaudewebMcp({url:cloud.url,passwordFor:async()=>'wrong',machine:'fixture',catalog,forward:async()=>({}),signal:controller.signal,status:state=>states.push(state)});
  t.after(()=>bridge.stop());
  assert.equal(await bridge.browserCode(),null);
  await until(()=>states.includes('config-error'));
  assert.equal(cloud.bootstrap,null);assert.ok(!states.includes('connected'));assert.equal(cloud.calls.length,1);
});

test('stopping while a saved credential is unavailable does not hang or submit it later',async t=>{
  const cloud=await fixture(t),controller=new AbortController();let release;
  const bridge=startClaudewebMcp({url:cloud.url,passwordFor:()=>new Promise(resolve=>{release=resolve;}),machine:'fixture',catalog,forward:async()=>({}),signal:controller.signal,status(){}});
  await bridge.stop();release('late-password');
  assert.equal(await bridge.browserCode(),null);assert.equal(cloud.calls.length,0);
});
