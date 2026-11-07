import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {discoverCloudcli,cloudcliOrigin,cloudcliName,cloudcliTargets} from '../cloudcli.mjs';
import {createDirectBrowser} from '../direct-browser.mjs';

async function fixture(t){const calls=[],sessions=new Map();let descriptor;const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(descriptor));return;}
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);calls.push(body);
  let record=sessions.get(body.id),value={ok:true};
  if(body.op==='prepare'){record??={};if(body.password)record.auth=true;sessions.set(body.id,record);}
  if(body.op==='stop')sessions.delete(body.id);
  if(record?.auth&&body.op!=='stop')value={sessionId:'cloudcli-session-fixture',cookie:'wd_cmcp=fixture-tool-token'};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;descriptor={protocol:'cmcp-cloudcli',version:1,desktopOrigin:'http://127.0.0.1:3000'};t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));return {origin,calls,sessions,setDescriptor:value=>{descriptor=value;}};}
async function launch(browser){const local=new URL(browser.launchUrl);const r=await fetch(local.origin+'/__mcp/direct',{method:'POST',headers:{origin:local.origin,'content-type':'application/json'},body:JSON.stringify({token:local.hash.slice(1)})});assert.equal(r.status,200);return(await r.json()).url;}
test('CloudCLI discovery is read-only and requires its declared pairing protocol',async t=>{
  const f=await fixture(t);assert.equal((await discoverCloudcli(f.origin)).desktopOrigin,'http://127.0.0.1:3000');assert.equal(f.calls.length,0);
  for(const value of [{protocol:'cmcp-direct',version:1},{protocol:'cmcp-cloudcli',version:2},{}]){f.setDescriptor(value);await assert.rejects(discoverCloudcli(f.origin),e=>e.code==='CLOUDCLI_PROTOCOL_REQUIRED');}
});
test('CloudCLI URLs reject credentials, paths and unsafe schemes, and profiles keep stable independent names',()=>{
  for(const url of ['http://cloudcli.example.com','https://user:secret@example.com','https://example.com/path','https://example.com/#token','file:///tmp/x'])assert.throws(()=>cloudcliOrigin(url));
  assert.equal(cloudcliName('device'),'cloudcli:device');assert.deepEqual(cloudcliTargets([{id:'device',url:'https://cloudcli.example.com',autoLogin:false}]).map(t=>[t.name,t.authMode,t.autoLogin]),[['cloudcli:device','cloudcli',false]]);
});
test('CloudCLI automatic sign-in opens the remote browser entrance and never repeats a successful password submission',async t=>{
  const f=await fixture(t);let reads=0;const browser=await createDirectBrowser({baseUrl:f.origin,launchPath:'/__webdesktop/cmcp',autoPassword:async()=>{reads++;return 'PRIVATE-PASSWORD';},pollMs:5});t.after(()=>browser.close());
  const first=new URL(await launch(browser));assert.equal(first.origin,f.origin);assert.equal(first.pathname,'/__webdesktop/cmcp');assert.match(first.hash,/^#cmcp=/);assert.equal(first.search,'');assert.ok(!first.href.includes('PRIVATE-PASSWORD'));assert.equal(browser.getSessionAuth().cookie,'wd_cmcp=fixture-tool-token');
  await launch(browser);assert.equal(reads,1);assert.equal(f.calls.filter(c=>c.password==='PRIVATE-PASSWORD').length,1);assert.equal(f.calls[0].id,f.calls[1].id);
});
test('manual CloudCLI sign-in waits for the browser and resumes the same scoped tool session',async t=>{
  const f=await fixture(t),browser=await createDirectBrowser({baseUrl:f.origin,launchPath:'/__webdesktop/cmcp',pollMs:5});t.after(()=>browser.close());await launch(browser);assert.equal(browser.getSessionAuth(),null);assert.ok(f.calls.every(c=>c.password===undefined));
  const [id,value]=[...f.sessions][0];value.auth=true;const until=Date.now()+2000;while(!browser.getSessionAuth()&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(browser.getSessionAuth().sessionId,'cloudcli-session-fixture');assert.equal(f.sessions.size,1);assert.equal([...f.sessions][0][0],id);
});
