// Sign-in for remote MCP servers whose manifest has "auth": {"type": "oauth"}. The tokens, the
// registered client and the PKCE verifier stay in the tool's secret store (DPAPI / keychain).
// Connections in the background never open a browser: they report that a sign-in is needed, and
// the user signs in from the Tools page, which runs login() below on a fixed loopback port.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {saveSecrets,loadSecrets,dropSecrets,atomicWrite} from './mcp-tools.mjs';

export const DEFAULT_CALLBACK_PORT=33418;
const KEYS={tokens:'oauth:tokens',client:'oauth:client',verifier:'oauth:verifier',discovery:'oauth:discovery'};
const loginFile=(stateDir,id)=>path.join(stateDir,'tool-login',id+'.json');
const secretsFile=(stateDir,id)=>path.join(stateDir,'tool-secrets',id+'.json');
export const LOGIN_MESSAGE='需要登录：在 CMCP 的“工具”页点“登录”，在浏览器里完成登录 (sign-in needed: CMCP Tools page > Sign in)';

export function loginNeeded(stateDir,id){try{return JSON.parse(fs.readFileSync(loginFile(stateDir,id),'utf8')).needed===true;}catch{return false;}}
export function markLogin(stateDir,id,needed){
  try{if(needed)atomicWrite(loginFile(stateDir,id),JSON.stringify({needed:true,at:Date.now()})+'\n');else fs.rmSync(loginFile(stateDir,id),{force:true});}catch{}
}
export const signedIn=(names)=>names.includes(KEYS.tokens);

export class ToolOAuth {
  constructor({stateDir,id,manifest,secrets,interactive=false,open=null}){
    Object.assign(this,{stateDir,id,manifest,store:secrets,interactive,open});
    this.redirect='http://127.0.0.1:'+(manifest.auth?.callbackPort||DEFAULT_CALLBACK_PORT)+'/callback';
    this.values={};this.stamp=null;this.expected=null;
  }
  get redirectUrl(){return this.redirect;}
  get clientMetadata(){
    return {client_name:'CMCP',redirect_uris:[this.redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',...this.manifest.auth?.scope?{scope:this.manifest.auth.scope}:{}};
  }
  // Reads the secret store again only when another process (the sign-in) changed it.
  async load(){
    let stamp='none';try{const s=fs.statSync(secretsFile(this.stateDir,this.id));stamp=s.mtimeMs+':'+s.size;}catch{}
    if(stamp!==this.stamp){this.values=this.store&&stamp!=='none'?await loadSecrets(this.stateDir,this.id,this.store):{};this.stamp=stamp;}
    return this.values;
  }
  async get(key){const raw=(await this.load())[KEYS[key]];if(raw===undefined)return undefined;try{return JSON.parse(raw);}catch{return undefined;}}
  async put(key,value){if(!this.store)throw Error('Secret store unavailable');await saveSecrets(this.stateDir,this.id,{[KEYS[key]]:JSON.stringify(value)},this.store);this.stamp=null;}
  async drop(keys){await dropSecrets(this.stateDir,this.id,keys.map(k=>KEYS[k]),this.store);this.stamp=null;}
  async clientInformation(){
    if(this.manifest.auth?.clientId)return {client_id:this.manifest.auth.clientId};
    const saved=await this.get('client');return saved&&saved.redirect===this.redirect?saved.info:undefined;
  }
  async saveClientInformation(info){await this.put('client',{redirect:this.redirect,info});}
  async tokens(){return this.get('tokens');}
  async saveTokens(tokens){await this.put('tokens',tokens);markLogin(this.stateDir,this.id,false);}
  async discoveryState(){return this.get('discovery');}
  async saveDiscoveryState(state){await this.put('discovery',state);}
  state(){this.expected=randomBytes(16).toString('hex');return this.expected;}
  // Only the sign-in started by the user keeps a verifier and opens the browser.
  async saveCodeVerifier(verifier){if(this.interactive)await this.put('verifier',verifier);}
  async codeVerifier(){const verifier=await this.get('verifier');if(!verifier)throw Error('No sign-in in progress');return verifier;}
  async redirectToAuthorization(url){
    if(!this.interactive){markLogin(this.stateDir,this.id,true);throw Object.assign(Error(LOGIN_MESSAGE),{code:'LOGIN_REQUIRED'});}
    this.authorizationUrl=url.href;await this.open(url.href);
  }
  async invalidateCredentials(scope){
    const keys=scope==='all'?['tokens','client','verifier','discovery']:scope==='client'?['client']:scope==='tokens'?['tokens']:scope==='verifier'?['verifier']:['discovery'];
    await this.drop(keys);
  }
}

// Opens the sign-in page in the default browser. Only web addresses are passed on.
export function openBrowser(url,platform=process.platform){
  const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw Error('Not a web address');
  const [command,args]=platform==='win32'?[path.join(process.env.SystemRoot||'C:\\Windows','System32','rundll32.exe'),['url.dll,FileProtocolHandler',u.href]]:platform==='darwin'?['open',[u.href]]:['xdg-open',[u.href]];
  const child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
}

const page=(title,text)=>'<!doctype html><meta charset="utf-8"><title>CMCP</title><body style="font:16px system-ui;margin:48px"><h2>'+title+'</h2><p>'+text+'</p></body>';

// A fresh sign-in: earlier tokens are dropped, the browser shows the provider's page, and the
// answer comes back to 127.0.0.1 on the manifest's callback port.
export async function login(stateDir,id,{manifest,secrets,open=openBrowser,timeoutMs=5*60000,fetchFn,onUrl=()=>{}}={}){
  if(manifest?.auth?.type!=='oauth')throw Error('This tool has no sign-in');
  if(!secrets)throw Error('Secret store unavailable');
  const provider=new ToolOAuth({stateDir,id,manifest,secrets,interactive:true,open:async url=>{onUrl(url);await open(url);}});
  await provider.drop(['tokens','verifier']);
  const port=Number(new URL(provider.redirect).port);
  // The answer may arrive while the browser is still being opened, before anything awaits it.
  let settle;const answer=new Promise((resolve,reject)=>{settle={resolve,reject};});answer.catch(()=>{});
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    if(u.pathname!=='/callback'){res.writeHead(404).end();return;}
    const error=u.searchParams.get('error'),code=u.searchParams.get('code'),state=u.searchParams.get('state');
    const ok=!error&&code&&provider.expected&&state===provider.expected;
    res.writeHead(ok?200:400,{'content-type':'text/html; charset=utf-8'});
    res.end(ok?page('已登录 · Signed in','可以关闭这个页面，回到 CMCP。You can close this page.'):page('登录没有完成 · Sign-in failed',error?'服务返回：'+String(error).replace(/[<>&"]/g,''):'回调内容不正确。'));
    if(ok)settle.resolve(code);else settle.reject(Error(error?'The provider refused the sign-in: '+error:'The sign-in answer did not match this request'));
  });
  await new Promise((resolve,reject)=>{server.once('error',error=>reject(error.code==='EADDRINUSE'?Error('本机端口 '+port+' 正被其他程序占用，无法接收登录结果 (port '+port+' is in use)'):error));server.listen(port,'127.0.0.1',resolve);});
  const timer=setTimeout(()=>settle.reject(Error('登录超时：5 分钟内没有完成 (sign-in timed out)')),timeoutMs);
  try{
    const scope=manifest.auth.scope;
    if(await auth(provider,{serverUrl:manifest.url,scope,fetchFn})==='AUTHORIZED'){markLogin(stateDir,id,false);return {signedIn:true};}
    const code=await answer;
    if(await auth(provider,{serverUrl:manifest.url,authorizationCode:code,scope,fetchFn})!=='AUTHORIZED')throw Error('Sign-in was not completed');
    await provider.drop(['verifier']);markLogin(stateDir,id,false);
    return {signedIn:true};
  }finally{clearTimeout(timer);server.close();server.closeAllConnections?.();}
}

export async function logout(stateDir,id,{secrets}={}){
  await dropSecrets(stateDir,id,Object.values(KEYS),secrets);markLogin(stateDir,id,false);return {signedIn:false};
}
