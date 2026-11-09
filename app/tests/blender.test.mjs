import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBlenderTools,blenderToolDefinitions} from '../blender-tools.mjs';
import {createSshDispatcher} from '../ssh-local-tools.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The tool folder of these temporary installs stays inside the test's own folders.
process.env.CMCP_MCP_TOOLS_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-blender-tools-'));
const content=result=>JSON.parse(result.content[0].text);
const enableBlender=directory=>fs.writeFileSync(path.join(directory,'tool-settings.json'),JSON.stringify({schema:1,groups:{blender:true}}));
async function addon(t,handle){
  const requests=[],sockets=new Set();
  const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});let body='';s.on('data',data=>{
    body+=data.toString();let cmd;try{cmd=JSON.parse(body);}catch{return;}
    requests.push(cmd);body='';Promise.resolve(handle(cmd,s)).catch(()=>s.destroy());
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
  return {port:server.address().port,requests};
}
const reply=(s,result)=>s.write(JSON.stringify({status:'success',result}));
function tools(t,options){const tools=createBlenderTools(options);t.after(()=>tools.close());return tools;}
async function completed(tool,id){
  for(let i=0;i<200;i++){const r=await tool.call('blender_job_status',{job_id:id});if(content(r).state!=='running')return r;await delay(10);}
  throw Error('Blender test job did not finish');
}

test('Blender definitions are stable, require no running add-on and never accept remote hosts',async t=>{
  const tool=tools(t);assert.equal(blenderToolDefinitions.length,6);
  for(const d of blenderToolDefinitions){assert.equal(d.inputSchema.additionalProperties,false);assert.ok(!d.inputSchema.properties.host);assert.equal(tool.owns(d.name),true);}
  for(const args of [{host:'example.com'},{port:0},{port:65536},{port:'9876'},{port:1.1}])await assert.rejects(tool.call('blender_get_scene_info',args),/Invalid Blender/);
  await assert.rejects(tool.call('blender_execute_code',{code:''}),/Invalid Blender/);
  await assert.rejects(tool.call('blender_execute_code',{code:'pass',timeout_ms:999}),/Invalid Blender/);
  await assert.rejects(tool.call('blender_get_object_info',{}),/Missing Blender/);
  await assert.rejects(tool.call('blender_get_viewport_screenshot',{filepath:'/tmp/arbitrary'}),/Invalid Blender/);
});

test('scene and object queries use the installed add-on protocol and preserve fragmented UTF-8',async t=>{
  const a=await addon(t,async(cmd,s)=>{
    const b=Buffer.from(JSON.stringify({status:'success',result:{name:cmd.params.name||'场景',type:cmd.type}}));
    const cut=b.indexOf(Buffer.from('景'))+1;s.write(b.subarray(0,cut));await delay(10);s.write(b.subarray(cut));
  }),tool=tools(t);
  const scene=content(await tool.call('blender_get_scene_info',{port:a.port}));assert.equal(scene.name,'场景');
  const object=content(await tool.call('blender_get_object_info',{port:a.port,name:'物体'}));assert.equal(object.name,'物体');
  assert.deepEqual(a.requests.map(c=>c.type),['get_scene_info','get_object_info']);
  assert.equal(content(await tool.call('blender_connection_status',{port:a.port})).connected,true);
});

test('missing Blender returns an actionable error, without breaking the tool catalog',async t=>{
  const temporary=net.createServer();await new Promise(resolve=>temporary.listen(0,'127.0.0.1',resolve));const port=temporary.address().port;await new Promise(resolve=>temporary.close(resolve));
  const tool=tools(t),r=await tool.call('blender_connection_status',{port});assert.equal(r.isError,true);assert.match(content(r).error,/Open Blender/);assert.equal(tool.definitions.length,6);
});

test('scripts return a job immediately, reject overlapping edits and retain results for polling',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const a=await addon(t,async(cmd,s)=>{await gate;reply(s,{executed:true,result:'Created cube 中文'});}),tool=tools(t);
  const started=Date.now(),job=content(await tool.call('blender_execute_code',{port:a.port,code:'print("Created cube")'}));assert.equal(job.state,'running');assert.ok(Date.now()-started<500);
  assert.equal(content(await tool.call('blender_connection_status',{port:a.port})).job_id,job.job_id);
  const busy=await tool.call('blender_execute_code',{port:a.port,code:'must not run'});assert.equal(busy.isError,true);assert.equal(content(busy).code,'BLENDER_BUSY');
  release();const done=await completed(tool,job.job_id);assert.equal(content(done).state,'succeeded');assert.match(content(done).result.result,/Created cube/);assert.equal(a.requests.length,1);
  assert.deepEqual(content(await tool.call('blender_job_status',{job_id:job.job_id})),content(done));
});

test('script timeout is an unknown outcome, never retried and never confused with a later reply',async t=>{
  const a=await addon(t,(cmd,s)=>{if(cmd.type==='get_scene_info')reply(s,{name:'Inspect before retry'});}),tool=tools(t);
  const job=content(await tool.call('blender_execute_code',{port:a.port,code:'long_render()',timeout_ms:1000}));
  const r=await completed(tool,job.job_id);assert.equal(r.isError,true);assert.equal(content(r).state,'unknown');assert.equal(content(r).outcome_unknown,true);assert.match(content(r).error,/does not cancel/);
  assert.equal(content(await tool.call('blender_get_scene_info',{port:a.port})).name,'Inspect before retry');assert.equal(a.requests.filter(c=>c.type==='execute_code').length,1);
});

test('add-on errors and disconnects distinguish script failure from an unknown execution outcome',async t=>{
  let mode='error';const a=await addon(t,(cmd,s)=>mode==='error'?s.write(JSON.stringify({status:'error',message:'Python ValueError: invalid mesh'})):s.destroy()),tool=tools(t);
  let j=content(await tool.call('blender_execute_code',{port:a.port,code:'raise ValueError()'}));let r=await completed(tool,j.job_id);assert.equal(content(r).state,'failed');assert.match(content(r).error,/ValueError/);
  mode='disconnect';j=content(await tool.call('blender_execute_code',{port:a.port,code:'maybe_changed_scene()'}));r=await completed(tool,j.job_id);assert.equal(content(r).state,'unknown');assert.equal(a.requests.length,2);
});

test('malformed, oversized and unanswered responses are bounded',async t=>{
  let mode='malformed';const a=await addon(t,(cmd,s)=>{if(mode==='malformed')s.write('{bad');else if(mode==='large')s.write('x'.repeat(1000));else reply(s,{error:'No 3D viewport found'});}),tool=tools(t,{readTimeoutMs:40,maxResponseBytes:200});
  let r=await tool.call('blender_get_scene_info',{port:a.port});assert.equal(content(r).code,'BLENDER_TIMEOUT');
  mode='large';r=await tool.call('blender_get_scene_info',{port:a.port});assert.equal(content(r).code,'BLENDER_RESPONSE_LIMIT');
  mode='error';r=await tool.call('blender_get_scene_info',{port:a.port});assert.equal(r.isError,true);assert.match(content(r).error,/viewport/);
});

test('viewport screenshots return MCP images and clean only their own temporary files',async t=>{
  let imagePath;const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZkAAAAASUVORK5CYII=','base64');
  const a=await addon(t,(cmd,s)=>{imagePath=cmd.params.filepath;fs.writeFileSync(imagePath,png);reply(s,{filepath:'/ignored/untrusted-return-path'});}),tool=tools(t);
  const r=await tool.call('blender_get_viewport_screenshot',{port:a.port,max_size:512});assert.equal(r.content[0].type,'image');assert.equal(r.content[0].mimeType,'image/png');assert.deepEqual(Buffer.from(r.content[0].data,'base64'),png);
  assert.equal(fs.existsSync(path.dirname(imagePath)),false);assert.equal(a.requests[0].params.format,'png');assert.equal(a.requests[0].params.max_size,512);
});

test('screenshot errors remove temporary files and reject non-PNG data',async t=>{
  let folder;const a=await addon(t,(cmd,s)=>{folder=path.dirname(cmd.params.filepath);fs.writeFileSync(cmd.params.filepath,'not an image');reply(s,{});}),tool=tools(t);
  const r=await tool.call('blender_get_viewport_screenshot',{port:a.port});assert.equal(r.isError,true);assert.match(content(r).error,/PNG/);assert.equal(fs.existsSync(folder),false);
});

test('closing the connector aborts sockets and reports uncertain jobs instead of hanging',async t=>{
  const a=await addon(t,()=>{}),tool=tools(t),job=content(await tool.call('blender_execute_code',{port:a.port,code:'pass'}));
  for(let i=0;i<100&&!a.requests.length;i++)await delay(5);await tool.close();
  assert.equal((await tool.call('blender_get_scene_info',{port:a.port})).isError,true);
  assert.equal(job.state,'running');
});

test('SSH dispatcher exports and calls Blender tools alongside the existing filesystem tools',{skip:!['win32','darwin'].includes(process.platform)},async t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-blender-dispatch-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.writeFileSync(path.join(directory,process.platform==='darwin'?'targets.json':'config.json'),JSON.stringify({roots:[directory],targets:[]}));enableBlender(directory);
  const a=await addon(t,(cmd,s)=>reply(s,{name:'Blender over SSH',type:cmd.type})),dispatcher=await createSshDispatcher(directory);t.after(()=>dispatcher.close());
  const forward=(method,params)=>dispatcher.forward({jsonrpc:'2.0',id:1,method,params});
  const listing=await forward('tools/list');assert.ok(listing.result.tools.some(d=>d.name==='blender_execute_code'));assert.ok(listing.result.tools.some(d=>d.name==='read_text_file'));
  const initialized=await forward('initialize',{protocolVersion:'2025-03-26'});assert.match(initialized.result.instructions,/currently open Blender/);
  const r=await forward('tools/call',{name:'blender_get_scene_info',arguments:{port:a.port}});assert.equal(content(r.result).name,'Blender over SSH');
  const invalid=await forward('tools/call',{name:'blender_execute_code',arguments:{code:42}});assert.equal(invalid.result.isError,true);
});

test('Windows web MCP endpoint routes scene, script jobs and images through the real SDK',{skip:process.platform!=='win32',timeout:25000},async t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-blender-web-'))),token='b'.repeat(64);
  fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify({roots:[directory],token}));enableBlender(directory);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZkAAAAASUVORK5CYII=','base64');
  const a=await addon(t,(cmd,s)=>{if(cmd.type==='get_viewport_screenshot'){fs.writeFileSync(cmd.params.filepath,png);reply(s,{});}else reply(s,{name:'Web MCP scene',executed:true,result:cmd.params.code});});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,CMCP_STATE_DIR:directory},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',errors='',exited=false;child.once('exit',()=>exited=true);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  t.after(async()=>{
    fs.writeFileSync(path.join(directory,'stopped.flag'),'owned test shutdown');
    for(let i=0;i<140&&!exited;i++)await delay(50);
    if(!exited){child.kill();await once(child,'exit');}
    fs.rmSync(directory,{recursive:true,force:true});
  });
  let port;for(let i=0;i<200&&!port;i++){assert.equal(exited,false,errors);port=/Windows MCP ready on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];if(!port)await delay(50);}assert.ok(port,errors||output);
  const headers={authorization:'Bearer '+token};
  const health=await(await fetch('http://127.0.0.1:'+port+'/health',{headers})).json();assert.ok(health.capabilities.includes('blender'));
  const client=new Client({name:'blender-web-test',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp'),{requestInit:{headers}}));
  assert.ok((await client.listTools()).tools.some(d=>d.name==='blender_execute_code'));
  const call=(name,args)=>client.callTool({name,arguments:{port:a.port,...args}});
  assert.equal(content(await call('blender_get_scene_info')).name,'Web MCP scene');
  const job=content(await call('blender_execute_code',{code:'print("verified")'}));
  let status;for(let i=0;i<100;i++){status=content(await client.callTool({name:'blender_job_status',arguments:{job_id:job.job_id}}));if(status.state!=='running')break;await delay(10);}assert.equal(status.state,'succeeded');
  assert.equal((await call('blender_get_viewport_screenshot')).content[0].type,'image');
});
