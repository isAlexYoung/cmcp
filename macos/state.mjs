import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWrite, privateDir, safeFile, readConfig, normalizeUrl, STATE} from './platform.mjs';

const iconPattern = /^data:image\/(?:png|jpeg|x-icon|vnd.microsoft.icon);base64,[A-Za-z0-9+/=]+$/;
export class ManagerState {
  constructor(directory=STATE, secrets) {
    this.directory=privateDir(directory);this.secrets=secrets;
    this.config=readConfig(directory);this.chain=Promise.resolve();
    this.preferences=this.read('application-preferences.json',{schema:1,language:'zh-CN',theme:'system',autoStart:false,closeAction:'tray',shortcutPrompt:true});
    this.controls=this.read('target-controls.json',{schema:1,targets:this.config.targets.map(t=>({name:t.id,enabled:false,revision:randomUUID(),requestTime:'0'}))});
    this.validateControls();this.validatePreferences(this.preferences);
  }
  read(name,fallback) {const file=path.join(this.directory,name);safeFile(file);try{if(fs.statSync(file).size>2*1024*1024)throw Error('Local state too large');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('本地设置损坏，原文件已保留');}}
  write(name,value){atomicWrite(path.join(this.directory,name),JSON.stringify(value,null,2));}
  serial(action){const promise=this.chain.then(action);this.chain=promise.catch(()=>{});return promise;}
  validateControls(){if(this.controls.schema!==1||!Array.isArray(this.controls.targets)||this.controls.targets.length>100)throw Error('Invalid controls');const seen=new Set();for(const t of this.controls.targets){if(typeof t.name!=='string'||seen.has(t.name)||typeof t.enabled!=='boolean'||typeof t.revision!=='string')throw Error('Invalid controls');seen.add(t.name);}}
  validatePreferences(p){if(p.schema!==1||!['zh-CN','en'].includes(p.language)||!['light','dark','system'].includes(p.theme)||!['tray','exit'].includes(p.closeAction)||typeof p.autoStart!=='boolean'||typeof p.shortcutPrompt!=='boolean')throw Error('设置格式无效');}
  get targets(){return this.config.targets;}
  controlMap(){return new Map(this.controls.targets.map(t=>[t.name,t]));}
  linkTargets(){return this.targets.map(t=>({name:t.id,url:t.url,stamp:t.changed,authMode:t.authMode,autoLogin:t.autoLogin===true}));}
  view(states={}){return {preferences:this.preferences,targets:this.targets.map(t=>{const enabled=this.controlMap().get(t.id)?.enabled===true;return {id:t.id,url:t.url,label:t.label||new URL(t.url).hostname,icon:t.icon||'',autoLogin:t.autoLogin===true,authMode:t.authMode||'legacy',hasSavedPassword:!!(t.credentialId||!t.authMode),enabled,...(enabled?(states[t.id]||{state:'connecting',message:'正在连接'}):{state:'stopped',message:'已停止'})};})};}
  setEnabled(id,enabled){if(id!==null&&!this.targets.some(t=>t.id===id))throw Error('连接不存在');const before=this.controlMap();this.controls={schema:1,targets:this.targets.map(t=>{const previous=before.get(t.id);const selected=id===null||t.id===id;return {name:t.id,enabled:selected?enabled:previous?.enabled===true,revision:selected?randomUUID():previous?.revision||randomUUID(),requestTime:String(Date.now())};})};this.write('target-controls.json',this.controls);}
  async save(input,detectShared){
    if(!input||typeof input!=='object')throw Error('Invalid target');
    const old=input.id?this.targets.find(t=>t.id===input.id):null;
    if(input.id&&!old)throw Error('连接不存在');
    const url=normalizeUrl(input.url),label=String(input.label||'').trim(),icon=input.icon||'';
    if(label.length>100||typeof icon!=='string'||icon.length>350000||(icon&&!iconPattern.test(icon)))throw Error('名称或图标无效');
    if(typeof input.autoLogin!=='boolean'||typeof input.password!=='string'||input.password.length>256)throw Error('密码或登录设置无效');
    if(this.targets.some(t=>t!==old&&t.url===url))throw Error('该地址已添加');
    if(!old&&this.targets.length>=100)throw Error('最多支持 100 个连接');
    const credentialsChanged=!old||old.url!==url||!!input.password||input.autoLogin!==(old.autoLogin===true);
    if(credentialsChanged&&old&&this.controlMap().get(old.id)?.enabled)throw Error('请先停止此连接，再修改地址、密码或自动登录');
    let authMode=old?.authMode||'legacy';
    if(credentialsChanged)authMode=await detectShared(url)?'shared-browser':'legacy';
    const remember=authMode==='legacy'||input.autoLogin;
    const previous=old?.credentialId||(!old?.authMode?old?.id:null);
    let credentialId=old?.url===url&&remember?previous:undefined,newCredential;
    if(remember&&input.password){newCredential=randomUUID();await this.secrets('set',newCredential,input.password);credentialId=newCredential;}
    if(remember&&!credentialId)throw Error('请输入密码');
    const target={...old,id:old?.id||randomUUID(),url,label,icon,authMode,autoLogin:authMode==='shared-browser'&&input.autoLogin,changed:credentialsChanged?randomUUID():old.changed};
    if(credentialId)target.credentialId=credentialId;else delete target.credentialId;
    const next={...this.config,targets:old?this.targets.map(t=>t===old?target:t):[...this.targets,target]};
    try{this.write('targets.json',next);}catch(e){if(newCredential)await this.secrets('delete',newCredential).catch(()=>{});throw e;}
    this.config=next;
    if(previous&&previous!==credentialId)await this.secrets('delete',previous).catch(()=>{});
    return target.id;
  }
  async remove(id){const old=this.targets.find(t=>t.id===id);if(!old)throw Error('连接不存在');this.setEnabled(id,false);const next={...this.config,targets:this.targets.filter(t=>t.id!==id)};this.write('targets.json',next);this.config=next;const ref=old.credentialId||(!old.authMode?old.id:null);if(ref)await this.secrets('delete',ref).catch(()=>{});}
  reorder(ids){if(!Array.isArray(ids)||ids.length!==this.targets.length||new Set(ids).size!==ids.length||ids.some(id=>!this.targets.some(t=>t.id===id)))throw Error('排序无效');const next={...this.config,targets:ids.map(id=>this.targets.find(t=>t.id===id))};this.write('targets.json',next);this.config=next;}
  settings(value){const next={...this.preferences,...value,schema:1};this.validatePreferences(next);this.write('application-preferences.json',next);this.preferences=next;}
  async password(id){const target=this.targets.find(t=>t.id===id);if(!target)throw Error('连接不存在');return this.secrets('get',target.credentialId||target.id);}
}
