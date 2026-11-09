// mcp-tools interface 1: manifest, paste import, names, switches, the generic proxy and the
// shared catalog, against a real stdio MCP server process (fixtures/mcp-tool-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {parseManifest,parseImport,installImported,exposedName,slug,readSettings,updateSettings,groupOf,toolsRoot,scanTools,approvalKey,describeTool,
  resolveLaunch,findExecutable,RuntimeMissing,ensureToolsFolder,loadSecrets,secretNames,requestRefresh,LOCAL_NAME_LIMIT} from '../mcp-tools.mjs';
import {createToolRegistry} from '../tool-registry.mjs';
import {ProxyServer,UNCERTAIN} from '../mcp-proxy.mjs';

const fixture=fileURLToPath(new URL('./fixtures/mcp-tool-fixture.mjs',import.meta.url));
const plainStore={protect:async value=>'plain:'+value,unprotect:async value=>value.slice(6)};
// Processes and watchers close before the folders go: Windows keeps a running tool's folder locked.
function folders(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-mcp-tools-'))),state=path.join(base,'user'),root=path.join(base,'mcp-tools'),closers=[];
  fs.mkdirSync(state);
  t.after(async()=>{await Promise.allSettled(closers.map(close=>close()));for(let i=0;;i++){try{fs.rmSync(base,{recursive:true,force:true});return;}catch(error){if(i>=50)throw error;await delay(100);}}});
  return {base,state,root,later:close=>closers.push(close)};
}
const manifest=(extra={})=>({schema:1,name:'Fixture',description:'Test server',transport:'stdio',command:'node',args:[fixture],capabilities:['exec'],...extra});
function addTool(root,id,m=manifest()){fs.mkdirSync(path.join(root,id),{recursive:true});fs.writeFileSync(path.join(root,id,'cmcp-tool.json'),JSON.stringify(m));return m;}
function enable(state,id,m){updateSettings(state,s=>{s.tools[id]=true;s.acknowledged[id]=approvalKey(m);});}
async function until(check,ms=15000){const end=Date.now()+ms;for(;;){const value=await check();if(value)return value;if(Date.now()>end)throw Error('condition timeout');await delay(50);}}
const builtin={definitions:[{name:'read_text_file',inputSchema:{type:'object'}},{name:'windows_execute',inputSchema:{type:'object'}},{name:'blender_get_scene_info',inputSchema:{type:'object'}},{name:'windows_system_info',inputSchema:{type:'object'}}],
  call:async name=>({content:[{type:'text',text:'builtin '+name}]})};
function registry(t,{state,root,later},options={}){const r=createToolRegistry({stateDir:state,root,providers:[builtin],serverName:'test-pc',version:'0',secrets:plainStore,instructions:{base:'Base.',blender:'Blender help.'},...options});later(()=>r.close());return r;}
const rpc=(r,method,params)=>r.forward({jsonrpc:'2.0',id:1,method,params});
const names=async r=>(await rpc(r,'tools/list')).result.tools.map(d=>d.name);

test('manifest schema 1 accepts a complete stdio and loopback HTTP tool and names every problem',()=>{
  assert.deepEqual(parseManifest(JSON.stringify(manifest()),{id:'fixture'}).errors,[]);
  const http=parseManifest(JSON.stringify({...manifest(),transport:'http',command:undefined,args:undefined,url:'http://127.0.0.1:8765/mcp',headers:{Authorization:{secret:true,template:'Bearer {value}'}}}),{id:'web'});
  assert.deepEqual(http.errors,[]);assert.deepEqual(http.secrets,['Authorization']);
  const bad=parseManifest(JSON.stringify({schema:1,transport:'http',url:'https://example.com/mcp',capabilities:['teleport'],lifecycle:'forever',maxConcurrency:99}),{id:'Bad-Name'});
  for(const pattern of [/name must/,/description/,/url must be/,/capabilities/,/lifecycle/,/maxConcurrency/,/folder name/])assert.ok(bad.errors.some(e=>pattern.test(e)),pattern+' in '+bad.errors);
  assert.match(parseManifest(JSON.stringify({...manifest(),schema:2})).errors[0],/newer CMCP/);
  assert.match(parseManifest('{"schema":1',{}).errors[0],/not valid JSON/);
  assert.ok(parseManifest(JSON.stringify(manifest()),{id:'blender'}).errors.some(e=>/reserved/.test(e)));
  assert.ok(parseManifest(JSON.stringify(manifest({command:'./../escape.exe'})),{id:'x',dir:'/tmp/tools/x'}).errors.some(e=>/leaves the tool folder/.test(e)));
  assert.ok(parseManifest(JSON.stringify(manifest({command:'curl'})),{id:'x'}).errors.some(e=>/command must be/.test(e)));
  const leaks=parseManifest(JSON.stringify(manifest({env:{API_TOKEN:'sk-live-abcdef123',MODE:'fast'},args:['pkg']})),{id:'x'});
  assert.deepEqual(leaks.warnings.filter(w=>w.code==='SECRET_IN_MANIFEST').map(w=>w.field),['env.API_TOKEN']);
  assert.ok(parseManifest(JSON.stringify(manifest({command:'uvx',args:['blender-mcp']})),{id:'x'}).warnings.some(w=>w.code==='UNPINNED'));
  assert.ok(!parseManifest(JSON.stringify(manifest({command:'uvx',args:['blender-mcp==1.4.0']})),{id:'x'}).warnings.some(w=>w.code==='UNPINNED'));
  assert.ok(parseManifest(JSON.stringify(manifest({platforms:['darwin']})),{id:'x',platform:'win32'}).errors.some(e=>/not available/.test(e)));
});

test('README snippets import in every common shape; values go to the secret store, never into the folder',async t=>{
  const shapes=['{"mcpServers":{"blender":{"command":"uvx","args":["blender-mcp"]}}}','{"blender":{"command":"uvx","args":["blender-mcp"]}}','{"command":"uvx","args":["blender-mcp"]}','"blender": {"command":"uvx","args":["blender-mcp"]}'];
  for(const text of shapes){const [item]=parseImport(text);assert.equal(item.manifest.command,'uvx');assert.deepEqual(item.manifest.args,['blender-mcp']);}
  assert.equal(parseImport(shapes[0])[0].id,'blender_mcp');
  const wrapped=parseImport('{"mcpServers":{"blender":{"command":"cmd","args":["/c","uvx","mcp-for-blender"],"env":{"BLENDER_PORT":"9876"}}}}')[0];
  assert.equal(wrapped.manifest.command,'uvx');assert.deepEqual(wrapped.manifest.args,['mcp-for-blender']);assert.equal(wrapped.manifest.env.BLENDER_PORT,'9876');assert.deepEqual(wrapped.secrets,{});
  assert.equal(slug('FreeCAD-MCP Server'),'freecad_mcp_server');assert.equal(slug('3d'),'t_3d');
  assert.throws(()=>parseImport('{"mcpServers":{"remote":{"type":"http","url":"https://mcp.example.com/mcp"}}}'),/VPS/);
  assert.throws(()=>parseImport('{"mcpServers":{"old":{"type":"sse","url":"http://127.0.0.1:1/sse"}}}'),/不支持 sse/);
  assert.throws(()=>parseImport('not json'),/JSON/);
  const two=parseImport('{"mcpServers":{"gh":{"command":"npx","args":["-y","@x/gh@1.0.0"],"env":{"GITHUB_TOKEN":"ghp_secret_value_1","MODE":"ro"}},"gh ":{"command":"npx","args":["y"]}}}');
  assert.deepEqual(two.map(i=>i.id),['gh','gh_2']);
  const {state,root}=folders(t);
  const dir=await installImported(root,state,two[0],{secrets:plainStore});
  const written=fs.readFileSync(path.join(dir,'cmcp-tool.json'),'utf8');
  assert.ok(!written.includes('ghp_secret_value_1'));assert.match(written,/"MODE": "ro"/);
  assert.deepEqual(secretNames(state,'gh'),['env:GITHUB_TOKEN']);assert.equal((await loadSecrets(state,'gh',plainStore))['env:GITHUB_TOKEN'],'ghp_secret_value_1');
  await assert.rejects(installImported(root,state,two[0],{secrets:plainStore}),/已有同名/);
});

test('exposed names carry the folder prefix and stay within the length every connector allows',()=>{
  assert.equal(exposedName('freecad','make_box'),'freecad__make_box');
  const long=exposedName('blender_mcp','a_very_long_upstream_tool_name_that_needs_truncation');
  assert.ok(long.length<=LOCAL_NAME_LIMIT&&long.startsWith('blender_mcp__'));
  assert.notEqual(exposedName('x','a.b'),exposedName('x','a_b'));
  // mcp__ + the 25-character SSH connector name + __ + this part stays within 64.
  assert.ok(('mcp__'+'cmcp-ssh-0123456789abcdef'+'__'+exposedName('abcdefghijklmnopqrst','tool_name_that_is_long')).length<=64);
});

test('switches: Blender starts off, groups map every built-in tool, and settings survive damage',t=>{
  const {state,base}=folders(t);
  const settings=readSettings(state);assert.equal(settings.groups.blender,false);assert.equal(settings.groups.files,true);assert.equal(settings.idleMinutes,30);
  fs.writeFileSync(path.join(state,'tool-settings.json'),'{broken');assert.equal(readSettings(state).groups.blender,false);
  updateSettings(state,s=>{s.groups.blender=true;s.idleMinutes=0;});assert.equal(readSettings(state).groups.blender,true);assert.equal(readSettings(state).idleMinutes,0);
  for(const [name,group] of [['read_text_file','files'],['windows_binary_read','files'],['mac_download_to_cloud','files'],['windows_execute','commands'],['mac_process_stdin','processes'],['windows_adb','toolchains'],['mac_keyboard','desktop'],['blender_execute_code','blender'],['windows_system_info','system'],['windows_new_thing','system']])assert.equal(groupOf(name),group,name);
  assert.equal(toolsRoot(path.join(base,'user'),'win32',{}),path.join(base,'mcp-tools'));
  const mac=path.resolve('/Users/a/Library/Application Support/CMCP');assert.equal(toolsRoot(mac,'darwin',{}),path.join(mac,'mcp-tools'));
  assert.equal(toolsRoot(mac,'darwin',{CMCP_MCP_TOOLS_DIR:base}),base);
});

test('the tools folder gets AGENT.md and examples, keeps the user\'s edits and skips _ folders',t=>{
  const {root}=folders(t);
  ensureToolsFolder(root);assert.ok(fs.existsSync(path.join(root,'AGENT.md')));assert.ok(fs.existsSync(path.join(root,'_examples','hello-node','cmcp-tool.json')));
  fs.appendFileSync(path.join(root,'AGENT.md'),'\nmy notes\n');ensureToolsFolder(root);
  assert.match(fs.readFileSync(path.join(root,'AGENT.md'),'utf8'),/my notes/);
  assert.deepEqual(scanTools(root),[]);
  const example=JSON.parse(fs.readFileSync(path.join(root,'_examples','hello-node','cmcp-tool.json'),'utf8'));
  assert.deepEqual(parseManifest(JSON.stringify(example),{id:'hello_node',dir:path.join(root,'_examples','hello-node')}).errors,[]);
});

test('catalog: groups switch built-ins, an unapproved tool stays hidden, an enabled one appears with its prefix',async t=>{
  const f=folders(t),r=registry(t,f);
  assert.deepEqual(await names(r),['read_text_file','windows_execute','windows_system_info']);
  const init=(await rpc(r,'initialize',{protocolVersion:'2025-06-18'})).result;assert.equal(init.instructions,'Base.');assert.equal(init.protocolVersion,'2025-06-18');
  const meta=(await rpc(r,'tools/list')).result._meta['cmcp/catalog'];assert.equal(meta.schema,1);assert.ok(meta.groups.includes('files')&&!meta.groups.includes('blender'));
  updateSettings(f.state,s=>{s.groups.blender=true;s.groups.commands=false;});
  assert.deepEqual(await names(r),['read_text_file','blender_get_scene_info','windows_system_info']);
  assert.match((await rpc(r,'initialize',{})).result.instructions,/Blender help/);
  assert.match((await rpc(r,'tools/call',{name:'windows_execute',arguments:{}})).error.message,/turned off/);
  const m=addTool(f.root,'fixture');updateSettings(f.state,s=>{s.tools.fixture=true;});
  assert.ok(!(await names(r)).some(n=>n.startsWith('fixture__')),'enabled but not confirmed');
  enable(f.state,'fixture',m);
  const listed=await until(async()=>{const n=await names(r);return n.includes('fixture__echo')&&n;});
  assert.ok(listed.every(n=>n.length<=LOCAL_NAME_LIMIT));
  const echo=(await rpc(r,'tools/list')).result.tools.find(d=>d.name==='fixture__echo');
  assert.equal(echo.inputSchema.$schema,undefined);assert.match(echo.description,/^\[Fixture\] Echo/);
  assert.equal((await rpc(r,'tools/call',{name:'fixture__echo',arguments:{text:'hi 你好'}})).result.content[0].text,'hi 你好');
  assert.match((await rpc(r,'initialize',{})).result.instructions,/third-party MCP servers/);
  const custom=r.custom().find(c=>c.id==='fixture');assert.equal(custom.enabled,true);assert.equal(custom.state,'running');
});

test('catalog changes are events: switches, folder edits, upstream list_changed and manual refresh',async t=>{
  const f=folders(t),r=registry(t,f),events=[];r.on('changed',revision=>events.push(revision));
  const m=addTool(f.root,'fixture');enable(f.state,'fixture',m);
  await until(()=>r.has('fixture__echo'));const after=events.length;assert.ok(after>=1);
  updateSettings(f.state,s=>{s.groups.files=false;});await until(()=>events.length>after);
  assert.ok(!(await names(r)).includes('read_text_file'));
  await rpc(r,'tools/call',{name:'fixture__grow',arguments:{}});
  await until(()=>r.has('fixture__grown_7'));
  // Editing the manifest into an invalid one removes the tool, its process stops; then removal works even on Windows.
  fs.writeFileSync(path.join(f.root,'fixture','cmcp-tool.json'),'{"schema":1}');await until(()=>!r.has('fixture__echo'));
  assert.match(r.custom().find(c=>c.id==='fixture').errors.join(),/name must/);
  const {remove}=await import('../mcp-tools-cli.mjs');process.env.CMCP_MCP_TOOLS_DIR=f.root;
  try{assert.match((await remove(f.state,'fixture')).keptAt,/\.removed-fixture-/);}finally{delete process.env.CMCP_MCP_TOOLS_DIR;}
  await until(()=>!r.custom().some(c=>c.id==='fixture'));
  const before=events.length;requestRefresh(f.state);await delay(800);
  assert.ok(events.length>=before);
  const revision=r.revision();updateSettings(f.state,s=>{s.idleMinutes=s.idleMinutes;});await delay(500);assert.equal(r.revision(),revision,'no change, no new revision');
});

test('proxy: environment and secrets reach the tool, CMCP variables do not; crashes are unknown outcomes and never retried',async t=>{
  const f=folders(t),marker=path.join(f.base,'starts.txt');
  const m=manifest({env:{FIXTURE_MARKER:marker,TOKEN:{secret:true}}});fs.mkdirSync(path.join(f.root,'fx'),{recursive:true});
  await (await import('../mcp-tools.mjs')).saveSecrets(f.state,'fx',{'env:TOKEN':'s3cret-value'},plainStore);
  const proxy=new ProxyServer({id:'fx',manifest:m,hash:'h',dir:path.join(f.root,'fx'),stateDir:f.state,secrets:plainStore,env:{...process.env,CMCP_STATE_DIR:'/private',CLOUDPC_LINK_SOCKET:'/x'},idleMs:0});
  f.later(()=>proxy.close());
  const text=r=>r.content[0].text;
  assert.equal(text(await proxy.call('env',{name:'TOKEN'})),'s3cret-value');
  assert.equal(text(await proxy.call('env',{name:'CMCP_STATE_DIR'})),'<unset>');
  assert.equal(text(await proxy.call('env',{name:'CLOUDPC_LINK_SOCKET'})),'<unset>');
  const crashed=await proxy.call('crash',{});assert.equal(crashed.isError,true);assert.ok(text(crashed).startsWith(UNCERTAIN));
  assert.equal(fs.readFileSync(marker,'utf8').trim().split('\n').length,1,'a crashed call is never resent');
  assert.equal(text(await proxy.call('echo',{text:'again'})),'again');
  const log=fs.readFileSync(path.join(f.state,'tool-logs','fx.log'),'utf8');assert.match(log,/call echo/);assert.ok(!log.includes('s3cret-value'));
  const asked=JSON.parse(text(await proxy.call('ask',{})));assert.match(asked.message,/does not support elicitation/);
});

test('proxy: idle processes stop and restart on the next call; repeated failures suspend the tool',async t=>{
  const f=folders(t),marker=path.join(f.base,'starts.txt'),m=manifest({env:{FIXTURE_MARKER:marker}});
  const proxy=new ProxyServer({id:'idle',manifest:m,hash:'h',dir:f.base,stateDir:f.state,secrets:plainStore,idleMs:300});f.later(()=>proxy.close());
  await proxy.call('echo',{text:'1'});assert.equal(proxy.state,'running');
  await until(()=>proxy.state==='stopped',5000);
  await proxy.call('echo',{text:'2'});assert.equal(fs.readFileSync(marker,'utf8').trim().split('\n').length,2);
  const never=new ProxyServer({id:'never',manifest:m,hash:'h',dir:f.base,stateDir:f.state,idleMs:0});f.later(()=>never.close());
  await never.call('echo',{text:'x'});await delay(400);assert.equal(never.state,'running','0 means never stop');
  const broken=new ProxyServer({id:'broken',manifest:manifest({args:[path.join(f.base,'missing.mjs')]}),hash:'h',dir:f.base,stateDir:f.state,idleMs:0,breaker:{failures:2,windowMs:60000}});f.later(()=>broken.close());
  for(let i=0;i<2;i++)assert.equal((await broken.call('echo',{text:'x'})).isError,true);
  assert.match((await broken.call('echo',{text:'x'})).content[0].text,/已暂停/);
});

test('proxy: per-tool concurrency queues calls instead of failing them',async t=>{
  const f=folders(t),proxy=new ProxyServer({id:'q',manifest:manifest({maxConcurrency:1}),hash:'h',dir:f.base,stateDir:f.state,idleMs:0});f.later(()=>proxy.close());
  const started=Date.now();const results=await Promise.all([proxy.call('slow',{ms:300}),proxy.call('slow',{ms:300})]);
  assert.deepEqual(results.map(r=>r.content[0].text),['slept','slept']);assert.ok(Date.now()-started>=550);
});

test('missing runtimes name what to install; nothing is installed',t=>{
  const empty=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-empty-path-'));t.after(()=>fs.rmSync(empty,{recursive:true,force:true}));
  assert.throws(()=>resolveLaunch('uvx',['x'],{platform:process.platform,env:{PATH:empty,Path:empty},dirs:[empty]}),e=>e instanceof RuntimeMissing&&e.runtime==='uv'&&/uv/.test(e.hint.zh));
  const node=resolveLaunch('node',['a.js'],{dirs:[empty],bundledNode:'/bundled/node'});assert.equal(node.command,'/bundled/node');
  assert.equal(findExecutable('definitely-not-a-program-cmcp'),null);
  const describe=describeTool(manifest({capabilities:['files','python']}));assert.match(describe.zh,/读写你的文件、运行 Python 代码/);assert.match(describe.en,/cannot limit/);
});

test('Windows runs npx through npm\'s own script with node.exe, never through a .cmd shell',{skip:process.platform!=='win32'},t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-npx-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'npx.cmd'),'@echo off');fs.writeFileSync(path.join(dir,'node.exe'),'');
  fs.mkdirSync(path.join(dir,'node_modules','npm','bin'),{recursive:true});fs.writeFileSync(path.join(dir,'node_modules','npm','bin','npx-cli.js'),'');
  const launch=resolveLaunch('npx',['-y','pkg@1.0.0'],{platform:'win32',dirs:[dir]});
  assert.equal(launch.command,path.join(dir,'node.exe'));assert.deepEqual(launch.args,[path.join(dir,'node_modules','npm','bin','npx-cli.js'),'-y','pkg@1.0.0']);
  fs.writeFileSync(path.join(dir,'uvx.cmd'),'@echo off');
  assert.throws(()=>resolveLaunch('uvx',[],{platform:'win32',dirs:[dir]}),/\.cmd/);
});
