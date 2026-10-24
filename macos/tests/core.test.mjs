import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createBinaryTools} from '../binary-tools.mjs';
import {createMacTools} from '../mac-tools.mjs';
import {createDispatcher} from '../dispatcher.mjs';
import {normalizeUrl,parseScutil,keychain,atomicWrite,readConfig,launchPlist} from '../platform.mjs';
import {shellQuote} from '../cloud-api.mjs';
const sha=buf=>createHash('sha256').update(buf).digest('hex');
function folder(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac-mcp-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function binary(t){const dir=folder(t),tool=createBinaryTools({roots:[dir]});t.after(()=>tool.close());return {dir,tool,call:async(name,a)=>(await tool.call('mac_binary_'+name,a)).structuredContent};}
test('HTTPS URL normalization rejects credentials, paths, queries and HTTP',()=>{
  assert.equal(normalizeUrl(' https://example.com/ '),'https://example.com');
  for(const url of ['http://example.com','https://u:p@example.com','https://example.com/a','https://example.com/?token=x','https://example.com/#a'])assert.throws(()=>normalizeUrl(url));
});
test('proxy parsing distinguishes CONNECT and unsupported PAC/SOCKS',()=>{
  assert.equal(parseScutil('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890'),'http://127.0.0.1:7890');
  assert.throws(()=>parseScutil('SOCKSEnable : 1'));
  assert.throws(()=>parseScutil('ProxyAutoConfigEnable : 1'));
  assert.throws(()=>parseScutil('HTTPSEnable : 1\nHTTPSProxy : evil/x\nHTTPSPort : 12'));
  assert.equal(parseScutil('HTTPEnable : 0'),'');
});
test('passwords travel only on stdin to a fixed keychain script',async()=>{
  const secret='secret"\n$(touch /tmp/bad) 中文',id=randomUUID();let called=false;
  await keychain('set',id,secret,async(file,args,options)=>{
    called=true;assert.equal(file,'/usr/bin/osascript');assert.ok(!JSON.stringify(args).includes(secret));
    assert.deepEqual(JSON.parse(options.input),{op:'set',id,password:secret});return '{"ok":true}';
  });assert.ok(called);
  assert.equal(await keychain('get',id,undefined,async()=>JSON.stringify({ok:true,data:Buffer.from(secret).toString('base64')})),secret);
  await assert.rejects(keychain('get',id,undefined,async()=>'{"ok":false,"status":-25300}'),/钥匙串/);
});
test('launchd plist escapes XML metacharacters and uses argument arrays',()=>{
  const xml=launchPlist('/a&b/node','/a<q>/kit','/a"b/state');
  assert.ok(xml.includes('/a&amp;b/node'));assert.ok(xml.includes('/a&lt;q&gt;/kit/service.mjs'));
  assert.ok(xml.includes('/a&quot;b/state/launchd.log'));assert.ok(!xml.includes('<key>UserName</key>'));
});
test('state writes are atomic and malformed configs are rejected',t=>{
  const dir=folder(t),file=path.join(dir,'targets.json');atomicWrite(file,'{"targets":[],"roots":["'+(process.platform==='win32'?'C:/':'/')+'"]}');
  assert.equal(readConfig(dir).targets.length,0);atomicWrite(file,'{"targets":[{}],"roots":["/"]}');assert.throws(()=>readConfig(dir));
  assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')).length,0);
  if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('state writer refuses symlinks and hardlinks', {skip:process.platform==='win32'},t=>{
  const dir=folder(t),outside=path.join(folder(t),'secret');fs.writeFileSync(outside,'original');
  const link=path.join(dir,'config');fs.symlinkSync(outside,link);assert.throws(()=>atomicWrite(link,'bad'));fs.unlinkSync(link);
  fs.linkSync(outside,link);assert.throws(()=>atomicWrite(link,'bad'));assert.equal(fs.readFileSync(outside,'utf8'),'original');
});
test('binary roundtrip preserves multimegabyte data and SHA-256',async t=>{
  const {dir,call}=binary(t),bytes=randomBytes(3*1048576+123),file=path.join(dir,'中文 file.bin');
  const u=await call('begin',{path:file,size:bytes.length,sha256:sha(bytes)});
  for(let offset=0;offset<bytes.length;offset+=u.chunk_size)await call('write',{upload_id:u.upload_id,offset,data:bytes.subarray(offset,offset+u.chunk_size).toString('base64')});
  await call('finish',{upload_id:u.upload_id});assert.equal(sha(fs.readFileSync(file)),sha(bytes));
  assert.equal((await call('info',{path:file})).sha256,sha(bytes));
  const r=await call('read',{path:file,offset:1048576,length:123});assert.deepEqual(Buffer.from(r.data,'base64'),bytes.subarray(1048576,1048699));
});
test('binary schemas reject unknown fields, offsets, type coercion and malformed hash',async t=>{
  const {dir,call}=binary(t),file=path.join(dir,'x');
  for(const a of [{path:file,size:-1,sha256:'f'.repeat(64)},{path:file,size:'0',sha256:'f'.repeat(64)},{path:file,size:0,sha256:'x'.repeat(64)},{path:file,size:0,sha256:sha(''),extra:true}])await assert.rejects(call('begin',a),/Invalid arguments/);
  await assert.rejects(call('read',{path:file,offset:0.5}));
});
test('binary uploads reject reordered, noncanonical base64 and oversize chunks',async t=>{
  const {dir,call}=binary(t),u=await call('begin',{path:path.join(dir,'x'),size:1,sha256:sha('x')});
  for(const [offset,data] of [[1,'eA=='],[0,'eB=='],[0,'***='],[0,'eHg=']])await assert.rejects(call('write',{upload_id:u.upload_id,offset,data}));
  await call('write',{upload_id:u.upload_id,offset:0,data:'eA=='});await call('finish',{upload_id:u.upload_id});
});
test('hash mismatch, cancellation and cleanup never publish partial files',async t=>{
  const {dir,call}=binary(t),file=path.join(dir,'x');
  let u=await call('begin',{path:file,size:1,sha256:sha('y')});await call('write',{upload_id:u.upload_id,offset:0,data:'eA=='});
  await assert.rejects(call('finish',{upload_id:u.upload_id}),/mismatch/);assert.ok(!fs.existsSync(file));assert.deepEqual(fs.readdirSync(dir),[]);
  u=await call('begin',{path:file,size:0,sha256:sha('')});await call('finish',{upload_id:u.upload_id,cancel:true});assert.deepEqual(fs.readdirSync(dir),[]);
});
test('existing and concurrently created destination requires explicit overwrite',async t=>{
  const {dir,call}=binary(t),file=path.join(dir,'x');fs.writeFileSync(file,'old');
  await assert.rejects(call('begin',{path:file,size:0,sha256:sha('')}),/exists/);
  fs.unlinkSync(file);const u=await call('begin',{path:file,size:0,sha256:sha('')});fs.writeFileSync(file,'raced');
  await assert.rejects(call('finish',{upload_id:u.upload_id}),/EEXIST/);assert.equal(fs.readFileSync(file,'utf8'),'raced');
  const u2=await call('begin',{path:file,size:0,sha256:sha(''),overwrite:true});await call('finish',{upload_id:u2.upload_id});assert.equal(fs.statSync(file).size,0);
});
test('binary tools reject paths outside roots, sibling prefixes and relative paths',async t=>{
  const {dir,call}=binary(t),outside=path.join(folder(t),'x');
  await assert.rejects(call('begin',{path:outside,size:0,sha256:sha('')}),/outside/);
  await assert.rejects(call('begin',{path:'relative',size:0,sha256:sha('')}),/absolute/);
  const sibling=dir+'-sibling';fs.mkdirSync(sibling);t.after(()=>fs.rmSync(sibling,{recursive:true,force:true}));
  await assert.rejects(call('begin',{path:path.join(sibling,'x'),size:0,sha256:sha('')}),/outside/);
});
test('symlink escapes and replaced upload parent are rejected', {skip:process.platform==='win32'},async t=>{
  const {dir,call}=binary(t),outside=folder(t);fs.writeFileSync(path.join(outside,'secret'),'hidden');
  fs.symlinkSync(outside,path.join(dir,'escape'));await assert.rejects(call('info',{path:path.join(dir,'escape','secret')}),/outside/);
  fs.symlinkSync(path.join(outside,'secret'),path.join(dir,'leaf'));await assert.rejects(call('info',{path:path.join(dir,'leaf')}));
  const sub=path.join(dir,'sub');fs.mkdirSync(sub);const u=await call('begin',{path:path.join(sub,'x'),size:0,sha256:sha('')});
  fs.renameSync(sub,sub+'-old');fs.symlinkSync(outside,sub);await assert.rejects(call('finish',{upload_id:u.upload_id}),/outside|changed/);assert.ok(!fs.existsSync(path.join(outside,'x')));
});
test('program argv is literal and foreground execution returns real exit codes',async t=>{
  const dir=folder(t),tools=createMacTools({roots:[dir]});t.after(()=>tools.close());
  const literal='"; $(touch bad) & 中文';
  const r=(await tools.call('mac_run_program',{program:process.execPath,args:['-e','process.stdout.write(process.argv[1]);process.exit(7)',literal],cwd:dir})).structuredContent;
  assert.equal(r.exit_code,7);assert.equal(r.output,literal);assert.equal(r.timed_out,false);
});
test('process output and runtime are bounded; no arbitrary PID stopping',async t=>{
  const dir=folder(t),tools=createMacTools({roots:[dir]});t.after(()=>tools.close());
  const r=(await tools.call('mac_run_program',{program:process.execPath,args:['-e','process.stdout.write("x".repeat(3*1024*1024));setInterval(()=>{},1000)'],timeout_ms:1000,cwd:dir})).structuredContent;
  assert.equal(r.timed_out,true);assert.equal(r.truncated,true);assert.ok(Buffer.byteLength(r.output)<=2*1024*1024);
  await assert.rejects(tools.call('mac_stop_process',{session_id:String(process.pid)}),/Unknown session/);
  await assert.rejects(tools.call('mac_stop_process',{pid:process.pid}),/Invalid arguments/);
});
test('background stdin and session close work',async t=>{
  const dir=folder(t),tools=createMacTools({roots:[dir]});t.after(()=>tools.close());
  const s=(await tools.call('mac_start_process',{program:process.execPath,args:['-e','process.stdin.pipe(process.stdout)'],cwd:dir})).structuredContent;
  await tools.call('mac_process_stdin',{session_id:s.session_id,data:'hello 中文',close:true});
  let status;for(let i=0;i<100;i++){status=(await tools.call('mac_process_status',{session_id:s.session_id})).structuredContent;if(!status.running)break;await delay(20);}
  assert.equal(status.running,false);assert.equal(status.output,'hello 中文');
});
test('POSIX group supervisor cleans children after leader exits', {skip:process.platform==='win32',timeout:10000},async t=>{
  const dir=folder(t),tools=createMacTools({roots:[dir]});t.after(()=>tools.close());const pidFile=path.join(dir,'descendant.pid');
  const code=`const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref();`;
  const r=(await tools.call('mac_run_program',{program:process.execPath,args:['-e',code,pidFile],cwd:dir})).structuredContent;assert.equal(r.exit_code,0);
  const pid=Number(fs.readFileSync(pidFile,'utf8'));await delay(100);
  let alive=false;try{process.kill(pid,0);if(process.platform==='linux')alive=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2]!=='Z';else alive=true;}catch{}
  assert.equal(alive,false,'descendant must be terminated');
});
test('dispatcher handles invalid JSON-RPC and tool failures',async t=>{
  const dir=folder(t),filesystem={async listTools(){return{tools:[]};},async close(){}};
  const d=await createDispatcher({roots:[dir],filesystem});t.after(()=>d.close());
  assert.equal((await d.forward([])).error.code,-32600);assert.equal(await d.forward({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  assert.equal((await d.forward({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'unlisted'}})).error.code,-32602);
  assert.equal((await d.forward({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'mac_execute',arguments:{command:3}}})).result.isError,true);
});
test('real filesystem SDK integration lists allowed roots and reads files',async t=>{
  const dir=folder(t),file=path.join(dir,'中文.txt');fs.writeFileSync(file,'verified');
  const d=await createDispatcher({roots:[dir]});t.after(()=>d.close());
  const r=await d.forward({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_text_file',arguments:{path:file}}});assert.ok(r.result.content.some(c=>c.text?.includes('verified')));
  const denied=await d.forward({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_text_file',arguments:{path:path.join(os.homedir(),'outside.txt')}}});assert.equal(denied.result.isError,true);
  assert.ok(d.definitions.every(t=>!t.inputSchema.$schema||t.inputSchema.$schema.includes('2020-12')));
});
test('cloud shell quoting does not interpolate apostrophes or substitutions',()=>{
  assert.equal(shellQuote("a'b$(x)"),"'a'\\''b$(x)'");
});
