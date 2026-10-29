import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {startLink} from '../link-client.mjs';

const until=async(fn,ms=8000)=>{const end=performance.now()+ms;while(!fn()){if(performance.now()>end)throw Error('condition timeout');await delay(10);}};
async function fixture(t,{wrongNonce=false,configured=false,realFiveSeconds=false,healthOptions={}}={}){
  const server=http.createServer((req,res)=>{req.resume();res.writeHead(req.url==='/api/auth/login'?200:404,{'content-type':'application/json','set-cookie':'wd_session=fixture'});res.end('{}');});
  const state={answer:false};
  const wss=new WebSocketServer({noServer:true,autoPong:false}),states=[],connections=[],timers=[];
  server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{
    assert.equal(req.headers.origin,`http://127.0.0.1:${server.address().port}`);
    connections.push(ws);
    ws.on('ping',data=>{if(state.answer)ws.pong(data);else if(wrongNonce)ws.pong(Buffer.from('wrong'));});
    ws.on('message',raw=>{if(JSON.parse(raw).t==='hello'){
      ws.send(JSON.stringify({t:'welcome'}));
      // Unrelated traffic does not prove that our probe was answered.
      timers.push(setInterval(()=>{if(ws.readyState===1)ws.send('{"t":"noise"}');},30));
    }});
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const link=startLink({name:'health',machine:'fixture',version:'test',target:()=>({url:`http://127.0.0.1:${server.address().port}`,proxy:async()=>'',password:async()=>'test'}),
    forward:async()=>null,askPassword:async()=>false,notify:()=>{},log:()=>{},status:{set:(n,s)=>states.push(s)},
    ...(configured?{onConnected:async()=>{throw Error('do-not-expose-setup-secret');}}:{}),
    ...(realFiveSeconds?{}:{healthOptions:{interval:50,timeout:200,hardTimeout:700,...healthOptions}})});
  t.after(async()=>{link.stop();timers.forEach(clearInterval);for(const ws of wss.clients)ws.terminate();await link.done;await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
  return {link,states,connections,state};
}

test('five-second default probes softly and keeps the original socket until matching pong returns',{timeout:9000},async t=>{
  const d=await fixture(t,{realFiveSeconds:true});await until(()=>d.states.includes('connected'));
  const began=performance.now();await until(()=>d.states.includes('unstable'),6500);
  assert.ok(performance.now()-began<6300);assert.ok(performance.now()-began>4500);
  assert.equal(d.connections.length,1);assert.equal(d.connections[0].readyState,1);assert.ok(!d.states.includes('recovering'));
  d.state.answer=true;await until(()=>d.states.at(-1)==='connected');assert.equal(d.connections.length,1);
});
test('wrong nonce cannot keep a failed application channel healthy',{timeout:4000},async t=>{
  const d=await fixture(t,{wrongNonce:true});await until(()=>d.states.includes('unstable'),1500);
  await until(()=>d.states.includes('recovering'),1500);
  await until(()=>d.connections.length===2,2000);
});
test('welcome never reports connected when connector setup failed',{timeout:3000},async t=>{
  const d=await fixture(t,{configured:true});await until(()=>d.states.includes('config-error'),1500);
  assert.ok(!d.states.includes('connected'));assert.ok(d.states.includes('configuring'));
});


test('soft recovery preserves setup outcome instead of announcing unverified tools',async t=>{
  const d=await fixture(t,{configured:true});await until(()=>d.states.includes('config-error'));await delay(300);
  assert.equal(d.states.at(-1),'config-error');d.state.answer=true;await delay(100);
  assert.ok(!d.states.includes('connected'));assert.equal(d.connections.length,1);
});

test('a brief lost pong recovers without rebuilding the socket or emitting disconnect',async t=>{
  const d=await fixture(t);await until(()=>d.states.includes('unstable'));
  d.state.answer=true;await until(()=>d.states.at(-1)==='connected');await delay(250);
  assert.equal(d.connections.length,1);assert.ok(!d.states.includes('recovering'));
});

test('client event-loop stalls allow a fresh probe before hard termination',async t=>{
  const d=await fixture(t);await until(()=>d.states.includes('connected'));
  d.state.answer=true;
  const end=performance.now()+900;while(performance.now()<end){} // Suspend both ends beyond the test hard deadline.
  await delay(250);assert.equal(d.connections.length,1);assert.ok(!d.states.includes('recovering'));
});
