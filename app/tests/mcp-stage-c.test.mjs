// Stage C: refresh on the legacy WebDesktop link, remote MCP servers (HTTP, SSE, OAuth).
import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyRevisionWriter} from '../link-client.mjs';

test('on the legacy link each new revision is written once into the connector\'s folder through the desktop API',async()=>{
  const calls=[],files=new Map();
  const api=async(endpoint,method,body)=>{
    calls.push(method+' '+endpoint.split('?')[0]);
    if(endpoint.startsWith('/api/sys/info'))return {home:'/home/ada'};
    if(method==='GET')return {entries:[...files.keys()].map(name=>({name,kind:'file'}))};
    if(method==='POST'){files.set(body.name,body.content);assert.equal(body.dir,'/home/ada/.local/share/cloudpc-link');return {};}
    if(method==='PUT'){assert.equal(body.path,'/home/ada/.local/share/cloudpc-link/catalog-revision');files.set('catalog-revision',body.content);return {};}
  };
  const write=legacyRevisionWriter({api});
  await write('r1');assert.equal(files.get('catalog-revision'),'r1\n');
  await write('r1');await write('r2');assert.equal(files.get('catalog-revision'),'r2\n');
  assert.deepEqual(calls,['GET /api/sys/info','GET /api/sys/fs','POST /api/sys/fs','GET /api/sys/fs','PUT /api/sys/fs'],'the same revision is not written twice');
  const logs=[];const linked=legacyRevisionWriter({api:async endpoint=>endpoint.startsWith('/api/sys/info')?{home:'/h'}:{entries:[{name:'catalog-revision',kind:'file',link:true}]},log:t=>logs.push(t)});
  await linked('r3');assert.match(logs[0],/not a plain file/,'a link in its place is never followed');
});

/* ---------------- Remote MCP servers ---------------- */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {parseManifest,parseImport,approvalKey,isRemote,describeTool,secretNames} from '../mcp-tools.mjs';
import {ProxyServer} from '../mcp-proxy.mjs';
import {login,logout,loginNeeded} from '../mcp-oauth.mjs';
import {status} from '../mcp-tools-cli.mjs';

const memoryStore=()=>({protect:async plain=>'mem:'+Buffer.from(plain).toString('base64'),unprotect:async stored=>Buffer.from(stored.slice(4),'base64').toString('utf8')});
function stateFolder(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-remote-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function mcpServer(){
  const server=new Server({name:'remote-fixture',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}));
  server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:'text',text:String(request.params.arguments?.text??'')}]}));
  return server;
}
async function listen(handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return server;}
async function freePort(){const s=await listen(()=>{});const port=s.address().port;await new Promise(r=>s.close(r));return port;}
const body=req=>new Promise(resolve=>{let text='';req.on('data',c=>text+=c);req.on('end',()=>resolve(text));});
const json=(res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};

test('remote servers: https only, network declared, no start, sign-in only where it makes sense',()=>{
  const base={schema:1,name:'R',description:'Remote',capabilities:['network']};
  const check=extra=>parseManifest(JSON.stringify({...base,...extra})).errors;
  assert.deepEqual(check({transport:'http',url:'https://mcp.example.com/mcp'}),[]);
  assert.deepEqual(check({transport:'sse',url:'https://mcp.example.com/sse',auth:{type:'oauth',scope:'read',callbackPort:40000}}),[]);
  assert.deepEqual(check({transport:'sse',url:'http://127.0.0.1:9000/sse'}),[]);
  assert.match(check({transport:'http',url:'http://mcp.example.com/mcp'}).join(),/https:\/\/ for a remote server/);
  assert.match(check({transport:'http',url:'https://u:p@mcp.example.com/mcp'}).join(),/user name or password/);
  assert.match(parseManifest(JSON.stringify({...base,capabilities:[],transport:'http',url:'https://mcp.example.com/mcp'})).errors.join(),/"network" capability/);
  assert.match(check({transport:'http',url:'https://mcp.example.com/mcp',start:{command:'node'}}).join(),/only for servers on this computer/);
  assert.match(check({transport:'http',url:'https://mcp.example.com/mcp',auth:{type:'basic'}}).join(),/auth must be/);
  assert.match(check({transport:'http',url:'https://mcp.example.com/mcp',auth:{type:'oauth',callbackPort:80}}).join(),/auth must be/);
  assert.match(check({transport:'stdio',command:'node',auth:{type:'oauth'}}).join(),/only for http and sse/);
  assert.equal(isRemote({transport:'http',url:'https://x.example/mcp'}),true);assert.equal(isRemote({transport:'http',url:'http://localhost:1/mcp'}),false);
  assert.match(describeTool({...base,transport:'http',url:'https://mcp.example.com/mcp',auth:{type:'oauth'}}).zh,/远程 MCP 服务 mcp\.example\.com.*浏览器里登录/);
  // Approvals given before sign-in existed stay valid: the key only grows for manifests with auth.
  const old={...base,transport:'stdio',command:'node',args:['a.mjs']};
  assert.equal(approvalKey(old),createHash('sha256').update(JSON.stringify(['stdio','node',['a.mjs'],'',null,['network']])).digest('hex'));
  assert.notEqual(approvalKey({...base,transport:'http',url:'https://a.example/mcp'}),approvalKey({...base,transport:'http',url:'https://a.example/mcp',auth:{type:'oauth'}}));
  // A pasted remote snippet: no key means a sign-in may be needed; a key goes to the secret store.
  const [plain]=parseImport('{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}');
  assert.deepEqual([plain.manifest.transport,plain.manifest.auth,plain.manifest.capabilities,plain.errors],['http',{type:'oauth'},['network'],[]]);
  const [keyed]=parseImport('{"mcpServers":{"x":{"type":"sse","url":"https://x.example/sse","headers":{"Authorization":"Bearer abc"}}}}');
  assert.deepEqual([keyed.manifest.transport,keyed.manifest.auth,keyed.manifest.headers,keyed.secrets],['sse',undefined,{Authorization:{secret:true}},{'header:Authorization':'Bearer abc'}]);
  assert.throws(()=>parseImport('{"mcpServers":{"x":{"type":"http","url":"http://x.example/mcp"}}}'),/https:\/\//);
});

test('an SSE server is listed and called like any other',async t=>{
  const sessions=new Map();
  const server=await listen(async(req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&u.pathname==='/sse'){const transport=new SSEServerTransport('/messages',res);sessions.set(transport.sessionId,transport);res.on('close',()=>sessions.delete(transport.sessionId));await mcpServer().connect(transport);return;}
    if(req.method==='POST'&&u.pathname==='/messages'){const transport=sessions.get(u.searchParams.get('sessionId'));if(!transport){res.writeHead(404).end();return;}await transport.handlePostMessage(req,res);return;}
    res.writeHead(404).end();
  });
  t.after(()=>{server.closeAllConnections();server.close();});
  const stateDir=stateFolder(t),manifest={schema:1,name:'S',description:'SSE',transport:'sse',url:'http://127.0.0.1:'+server.address().port+'/sse',capabilities:[]};
  const proxy=new ProxyServer({id:'sse',manifest,hash:'h',dir:stateDir,stateDir,secrets:null,idleMs:0});t.after(()=>proxy.close());
  assert.deepEqual((await proxy.refresh()).map(x=>x.name),['echo']);
  assert.equal((await proxy.call('echo',{text:'over sse'})).content[0].text,'over sse');
});

// A remote server that needs a bearer token, with its own OAuth authorization server.
async function oauthServer(t){
  const state={codes:new Map(),tokens:new Set(),refresh:new Set(),registered:0,issued:0};
  let base;
  const server=await listen(async(req,res)=>{
    const u=new URL(req.url,base);
    if(u.pathname==='/.well-known/oauth-protected-resource'||u.pathname==='/.well-known/oauth-protected-resource/mcp')return json(res,200,{resource:base+'/mcp',authorization_servers:[base]});
    if(u.pathname==='/.well-known/oauth-authorization-server')return json(res,200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
    if(u.pathname==='/register'){const meta=JSON.parse(await body(req));state.registered++;state.redirects=meta.redirect_uris;return json(res,201,{...meta,client_id:'client-'+state.registered,client_id_issued_at:Math.floor(Date.now()/1000)});}
    if(u.pathname==='/authorize'){
      const redirect=new URL(u.searchParams.get('redirect_uri'));assert.ok(state.redirects.includes(redirect.href),'only the registered callback');
      assert.equal(u.searchParams.get('code_challenge_method'),'S256');
      const code='code-'+Math.random().toString(16).slice(2);state.codes.set(code,u.searchParams.get('code_challenge'));
      redirect.searchParams.set('code',code);redirect.searchParams.set('state',u.searchParams.get('state'));
      res.writeHead(302,{location:redirect.href}).end();return;
    }
    if(u.pathname==='/token'){
      const form=new URLSearchParams(await body(req));
      if(form.get('grant_type')==='authorization_code'){
        const challenge=state.codes.get(form.get('code'));state.codes.delete(form.get('code'));
        if(!challenge||createHash('sha256').update(form.get('code_verifier')).digest('base64url')!==challenge)return json(res,400,{error:'invalid_grant'});
      } else if(form.get('grant_type')==='refresh_token'){if(!state.refresh.has(form.get('refresh_token')))return json(res,400,{error:'invalid_grant'});}
      else return json(res,400,{error:'unsupported_grant_type'});
      const access='access-token-'+(++state.issued),refresh='refresh-token-'+state.issued;state.tokens.add(access);state.refresh.add(refresh);
      return json(res,200,{access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh});
    }
    if(u.pathname==='/mcp'){
      const token=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];
      if(!state.tokens.has(token))return json(res,401,{error:'invalid_token'},{'www-authenticate':'Bearer resource_metadata="'+base+'/.well-known/oauth-protected-resource/mcp"'});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>transport.close());await mcpServer().connect(transport);await transport.handleRequest(req,res,req.method==='POST'?JSON.parse(await body(req)):undefined);return;
    }
    res.writeHead(404).end();
  });
  base='http://127.0.0.1:'+server.address().port;
  t.after(()=>{server.closeAllConnections();server.close();});
  return {base,state};
}

test('OAuth: the background asks for a sign-in, the browser sign-in stores tokens, expired tokens are refreshed',async t=>{
  const {base,state}=await oauthServer(t),stateDir=stateFolder(t),secrets=memoryStore(),port=await freePort();
  const manifest={schema:1,name:'Remote',description:'OAuth fixture',transport:'http',url:base+'/mcp',capabilities:['network'],auth:{type:'oauth',callbackPort:port}};
  const proxy=new ProxyServer({id:'remote',manifest,hash:'h',dir:stateDir,stateDir,secrets,idleMs:0});t.after(()=>proxy.close());
  // Without a sign-in: a clear state, no browser, and no strike against the tool.
  let opened=0;
  await assert.rejects(proxy.refresh(),error=>error.code==='LOGIN_REQUIRED'&&/工具.*登录/.test(error.message));
  assert.deepEqual([proxy.status().state,proxy.failures.length,loginNeeded(stateDir,'remote')],['login-required',0,true]);
  assert.match((await proxy.call('echo',{text:'x'})).content[0].text,/登录/);
  // The sign-in the user starts: the "browser" follows the provider's redirect to the loopback callback.
  const browser=async url=>{opened++;const step=await fetch(url,{redirect:'manual'});const back=step.headers.get('location');assert.ok(back.startsWith('http://127.0.0.1:'+port+'/callback?'));const page=await fetch(back);assert.equal(page.status,200);assert.match(await page.text(),/已登录/);};
  assert.deepEqual(await login(stateDir,'remote',{manifest,secrets,open:browser}),{signedIn:true});
  assert.equal(opened,1);assert.equal(loginNeeded(stateDir,'remote'),false);
  assert.ok(secretNames(stateDir,'remote').includes('oauth:tokens'));assert.ok(!secretNames(stateDir,'remote').includes('oauth:verifier'),'the verifier is not kept');
  assert.ok(!fs.readFileSync(path.join(stateDir,'tool-secrets','remote.json'),'utf8').includes('access-token'),'tokens only through the secret store');
  // The background connection now works with the stored token.
  assert.deepEqual((await proxy.refresh()).map(x=>x.name),['echo']);
  assert.equal((await proxy.call('echo',{text:'signed in'})).content[0].text,'signed in');
  // The server forgets the access token: the refresh token gets a new one without a browser.
  await proxy.stop();state.tokens.clear();
  assert.equal((await proxy.call('echo',{text:'refreshed'})).content[0].text,'refreshed');
  assert.equal(opened,1);assert.ok(state.issued>=2);
  const log=fs.readdirSync(path.join(stateDir,'tool-logs')).map(f=>fs.readFileSync(path.join(stateDir,'tool-logs',f),'utf8')).join('');
  assert.doesNotMatch(log,/access-token-|refresh-token-/,'no token in the log');
  // A sign-in answer that does not match the request is refused.
  const forged=async url=>{const step=await fetch(url,{redirect:'manual'});const back=new URL(step.headers.get('location'));back.searchParams.set('state','forged');assert.equal((await fetch(back)).status,400);};
  await assert.rejects(login(stateDir,'remote',{manifest,secrets,open:forged}),/did not match/);
  // Signing out removes the sign-in and keeps nothing behind.
  await logout(stateDir,'remote',{secrets});assert.ok(!secretNames(stateDir,'remote').some(k=>k.startsWith('oauth:')));
  await proxy.stop();state.tokens.clear();state.refresh.clear();
  await assert.rejects(proxy.refresh(),error=>error.code==='LOGIN_REQUIRED');
});

test('the Tools page sees which remote tools need a sign-in',async t=>{
  const stateDir=stateFolder(t),root=path.join(stateDir,'mcp-tools');process.env.CMCP_MCP_TOOLS_DIR=root;t.after(()=>{delete process.env.CMCP_MCP_TOOLS_DIR;});
  fs.mkdirSync(path.join(root,'linear'),{recursive:true});
  fs.writeFileSync(path.join(root,'linear','cmcp-tool.json'),JSON.stringify({schema:1,name:'Linear',description:'Remote',transport:'http',url:'https://mcp.linear.app/mcp',capabilities:['network'],auth:{type:'oauth'}}));
  let tool=status(stateDir).tools.find(x=>x.id==='linear');
  assert.deepEqual([tool.remote,tool.auth,tool.runtime],[true,{type:'oauth',signedIn:false,needed:false},null]);
  fs.mkdirSync(path.join(stateDir,'tool-login'));fs.writeFileSync(path.join(stateDir,'tool-login','linear.json'),'{"needed":true}');
  tool=status(stateDir).tools.find(x=>x.id==='linear');assert.equal(tool.auth.needed,true);
});
