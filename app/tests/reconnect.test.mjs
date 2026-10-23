import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {startLink} from '../link-client.mjs';

async function until(check,timeout=7000){const deadline=Date.now()+timeout;while(!check()){if(Date.now()>deadline)throw Error('condition timeout');await delay(10);}}
async function fixture(t,{rejectUpgrades=0,unauthorized=false,passwordRejected=false}={}){
  const counts={login:0,upgrade:0,proxy:0},times=[],states=[];
  const server=http.createServer((req,res)=>{
    req.resume();
    if(req.url==='/api/auth/login'){
      counts.login++;res.writeHead(passwordRejected?401:200,{'content-type':'application/json',...(passwordRejected?{}:{'set-cookie':'wd_session=session-'+counts.login+'; HttpOnly'})});
      res.end(passwordRejected?'null':'{}');
    }else{res.writeHead(404);res.end();}
  });
  const wss=new WebSocketServer({noServer:true});const connections=[];
  server.on('upgrade',(req,socket,head)=>{
    counts.upgrade++;times.push(Date.now());
    if(counts.upgrade<=rejectUpgrades){
      if(unauthorized)socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
      return;
    }
    wss.handleUpgrade(req,socket,head,ws=>{
      connections.push(ws);ws.on('message',raw=>{const m=JSON.parse(raw);if(m.t==='hello'){ws.send('null');ws.send('[]');ws.send(JSON.stringify({t:'welcome'}));}});
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const link=startLink({name:'test',machine:'same-machine',version:'test',
    target:()=>({url:`http://127.0.0.1:${server.address().port}`,password:async()=>'test',proxy:async()=>{counts.proxy++;return '';}}),
    forward:async()=>null,askPassword:async()=>false,notify:()=>{},log:()=>{},status:{set:(name,state,message)=>states.push({state,message})}});
  t.after(async()=>{link.stop();for(const ws of wss.clients)ws.terminate();await link.done;await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
  return{counts,times,states,link,connections};
}

test('network handshake failures retain login, refresh proxy and increase retry delay',{timeout:10000},async t=>{
  const d=await fixture(t,{rejectUpgrades:2});await until(()=>d.states.at(-1)?.state==='connected');
  assert.equal(d.counts.login,1);assert.equal(d.counts.upgrade,3);assert.equal(d.counts.proxy,3);
  assert.ok(d.times[1]-d.times[0]>=900);assert.ok(d.times[2]-d.times[1]>=1900);
});

test('explicit HTTP 401 invalidates cookie and authenticates again',{timeout:6000},async t=>{
  const d=await fixture(t,{rejectUpgrades:1,unauthorized:true});await until(()=>d.states.at(-1)?.state==='connected');
  assert.equal(d.counts.login,2);assert.equal(d.counts.upgrade,2);
});

test('same-machine takeover stops instead of competing with the newer connection',{timeout:5000},async t=>{
  const d=await fixture(t);await until(()=>d.states.at(-1)?.state==='connected');
  d.connections[0].close(4002,'reconnected');await d.link.done;await delay(1100);
  assert.equal(d.states.at(-1).state,'replaced');assert.equal(d.counts.upgrade,1);
});

test('rejected password is not retried and stop cancels the settings wait',{timeout:5000},async t=>{
  const d=await fixture(t,{passwordRejected:true});await until(()=>d.states.at(-1)?.state==='password');await delay(1100);
  assert.equal(d.counts.login,1);d.link.stop();await d.link.done;
});
