import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWrite, privateDir, safeFile, readConfig, normalizeUrl, STATE} from './platform.mjs';
import {sshProblem} from './ssh.mjs';

const iconPattern = /^data:image\/(?:png|jpeg|x-icon|vnd.microsoft.icon);base64,[A-Za-z0-9+/=]+$/;
export class ManagerState {
  constructor(directory=STATE, secrets) {
    this.directory=privateDir(directory);this.secrets=secrets;
    this.config=readConfig(directory);this.chain=Promise.resolve();
    this.preferences=this.read('application-preferences.json',{schema:1,language:'zh-CN',theme:'system',autoStart:false,closeAction:'tray',shortcutPrompt:true});
    this.controls=this.read('target-controls.json',{schema:1,targets:this.config.targets.map(t=>({name:t.id,enabled:false,revision:randomUUID(),requestTime:'0'}))});
    this.ssh=this.read('ssh-logins.json',{schema:1,logins:[],order:[]});
    this.validateControls();this.validatePreferences(this.preferences);this.validateSsh();
  }
  read(name,fallback) {const file=path.join(this.directory,name);safeFile(file);try{if(fs.statSync(file).size>2*1024*1024)throw Error('Local state too large');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('本地设置损坏，原文件已保留');}}
  write(name,value){atomicWrite(path.join(this.directory,name),JSON.stringify(value,null,2));}
  serial(action){const promise=this.chain.then(action);this.chain=promise.catch(()=>{});return promise;}
  validateControls(){if(this.controls.schema!==1||!Array.isArray(this.controls.targets)||this.controls.targets.length>100)throw Error('Invalid controls');const seen=new Set();for(const t of this.controls.targets){if(typeof t.name!=='string'||seen.has(t.name)||typeof t.enabled!=='boolean'||typeof t.revision!=='string')throw Error('Invalid controls');seen.add(t.name);}}
  validatePreferences(p){if(p.schema!==1||!['zh-CN','en'].includes(p.language)||!['light','dark','system'].includes(p.theme)||!['tray','exit'].includes(p.closeAction)||typeof p.autoStart!=='boolean'||typeof p.shortcutPrompt!=='boolean'||(p.terminal!==undefined&&(typeof p.terminal!=='string'||p.terminal.length>32))||(p.browser!==undefined&&(typeof p.browser!=='string'||p.browser.length>32))||(p.closeWeb!==undefined&&typeof p.closeWeb!=='boolean')||(p.closeTerminal!==undefined&&typeof p.closeTerminal!=='boolean'))throw Error('设置格式无效');}
  // SSH details stay out of web targets; the independent SSH MCP worker reads them.
  validateSsh(){const s=this.ssh;if(s.schema!==1||!Array.isArray(s.logins)||!Array.isArray(s.order)||s.logins.length>100)throw Error('本地设置损坏，原文件已保留');if([...this.targets,...s.logins].some(t=>!t||(t.hideAddress!==undefined&&typeof t.hideAddress!=="boolean")))throw Error("本地设置损坏，原文件已保留");if(s.modes!==undefined&&(!s.modes||typeof s.modes!=="object"||Array.isArray(s.modes)||Object.keys(s.modes).length>100||Object.entries(s.modes).some(([id,mode])=>!/^[a-f0-9-]{36}$/.test(id)||!["web","ssh"].includes(mode))))throw Error("本地设置损坏，原文件已保留");const seen=new Set();for(const l of s.logins){if(!l||!/^[a-f0-9-]{36}$/.test(l.id)||seen.has(l.id)||sshProblem(l)||(l.credentialId!==undefined&&!/^[a-f0-9-]{36}$/.test(l.credentialId)))throw Error('本地设置损坏，原文件已保留');seen.add(l.id);}}
  loginMode(id){return this.ssh.modes?.[id]||(this.sshFor(id)?.active||!this.targets.some(t=>t.id===id)?"ssh":"web");}
  sshFor(id){return this.ssh.logins.find(l=>l.id===id)||null;}
  get sshOnly(){return this.ssh.logins.filter(l=>!this.targets.some(t=>t.id===l.id));}
  sshView(login){if(!login)return null;return {host:login.host,port:login.port,username:login.username,method:login.method,keyPath:login.keyPath||'',hasSecret:!!login.credentialId,active:this.loginMode(login.id)==='ssh',address:login.username+'@'+login.host+':'+login.port,command:'ssh -p '+login.port+(login.method==='key'?' -i "'+login.keyPath+'"':'')+' '+login.username+'@'+login.host};}
  ordered(list){const rank=new Map(this.ssh.order.map((id,i)=>[id,i])),at=item=>rank.has(item.id)?rank.get(item.id):Infinity;return list.map((item,i)=>[item,i]).sort(([a,i],[b,j])=>at(a)===at(b)?i-j:at(a)-at(b)).map(([item])=>item);}
  get targets(){return this.config.targets;}
  controlMap(){return new Map(this.controls.targets.map(t=>[t.name,t]));}
  linkTargets(){return this.targets.map(t=>({name:t.id,url:t.url,stamp:t.changed,authMode:t.authMode,autoLogin:t.autoLogin===true}));}
  view(states={}){const web=this.targets.map(t=>{const enabled=this.controlMap().get(t.id)?.enabled===true;return {id:t.id,url:t.url,label:t.label||new URL(t.url).hostname,icon:t.icon||'',note:t.note||'',hideAddress:t.hideAddress===true,customLabel:!!t.label,autoLogin:t.autoLogin===true,authMode:t.authMode||'legacy',hasSavedPassword:!!(t.credentialId||!t.authMode),ssh:this.sshView(this.sshFor(t.id)),loginMode:this.loginMode(t.id),enabled,...(enabled?(states[t.id]||{state:'connecting',message:'正在连接'}):{state:'stopped',message:'已停止'})};}),only=this.sshOnly.map(l=>({id:l.id,url:'',label:l.label||l.host,icon:l.icon||'',note:l.note||'',hideAddress:l.hideAddress===true,customLabel:!!l.label,autoLogin:false,authMode:'ssh',hasSavedPassword:false,ssh:this.sshView(l),loginMode:this.loginMode(l.id),enabled:false,state:'stopped',message:'已停止'}));return {preferences:this.preferences,targets:this.ordered([...web,...only])};}
  setEnabled(id,enabled){if(id!==null&&!this.targets.some(t=>t.id===id))throw Error(enabled&&this.sshFor(id)?'还没有填写共享网页地址，请编辑设备后再连接。':'连接不存在');const before=this.controlMap();this.controls={schema:1,targets:this.targets.map(t=>{const previous=before.get(t.id);const selected=id===null||t.id===id;return {name:t.id,enabled:selected?enabled:previous?.enabled===true,revision:selected?randomUUID():previous?.revision||randomUUID(),requestTime:String(Date.now())};})};this.write('target-controls.json',this.controls);}
  sshDraft(value){
    if(!value||typeof value!=='object'||(value.secret!==undefined&&(typeof value.secret!=='string'||value.secret.length>256)))throw Error('请输入正确的主机地址（域名或 IP）。');
    const draft={host:String(value.host??'').trim(),port:Number(String(value.port??'').trim()),username:String(value.username??'').trim(),method:value.method,keyPath:value.method==='key'?String(value.keyPath??'').trim():''};
    const problem=sshProblem(draft);if(problem)throw Error(problem);
    if(draft.method==='key'){if(draft.keyPath.toLowerCase().endsWith('.pub'))throw Error('这是公钥文件，请选择不带 .pub 的私钥文件。');if(!fs.existsSync(draft.keyPath))throw Error('找不到这个私钥文件。');}
    return draft;
  }
  async save(input,detectShared){
    if(!input||typeof input!=='object')throw Error('Invalid target');
    const old=input.id?this.targets.find(t=>t.id===input.id):null,oldLogin=input.id?this.sshFor(input.id):null;
    if(input.id&&!old&&!oldLogin)throw Error('连接不存在');
    // Older callers send no ssh field and always mean a web address.
    const sshGiven=input.ssh!==undefined,wantsWeb=!sshGiven||String(input.url??'').trim()!=='';
    if(sshGiven&&!wantsWeb&&!input.ssh)throw Error('请至少填写一种登录方式：共享网页地址或 SSH 主机。');
    const hideAddress=input.hideAddress===undefined?(old?.hideAddress??oldLogin?.hideAddress??false):input.hideAddress;if(typeof hideAddress!=='boolean')throw Error('显示设置无效');input={...input,hideAddress};
    const label=String(input.label||'').trim(),icon=input.icon||'',note=typeof input.note==='string'?input.note.trim():old?.note||'';
    if(label.length>100||typeof icon!=='string'||icon.length>350000||(icon&&!iconPattern.test(icon)))throw Error('名称或图标无效');
    if(note.length>200||/[\u0000-\u0009\u000b\u000c\u000e-\u001f]/.test(note))throw Error('备注不能包含控制字符。');
    if(!old&&!oldLogin&&this.targets.length+this.sshOnly.length>=100)throw Error('最多保存 100 台设备。');
    const id=old?.id||oldLogin?.id||randomUUID(),draft=sshGiven&&input.ssh?this.sshDraft(input.ssh):null;
    if(!wantsWeb&&old&&this.controlMap().get(id)?.enabled)throw Error('请先停止此连接，再删除共享网页登录。');
    if(wantsWeb)await this.saveWeb(input,old,id,label,icon,note,detectShared);
    else if(old)await this.dropWeb(old);
    if(sshGiven)await this.saveSsh(id,input,draft,oldLogin,wantsWeb,label,icon,note);
    return id;
  }
  async dropWeb(old){this.setEnabled(old.id,false);const next={...this.config,targets:this.targets.filter(t=>t!==old)};this.write('targets.json',next);this.config=next;const ref=old.credentialId||(!old.authMode?old.id:null);if(ref)await this.secrets('delete',ref).catch(()=>{});}
  // A saved secret is kept only for the same server, user and method, so it can never reach a server just typed in.
  async saveSsh(id,input,draft,old,hasWeb,label,icon,note){
    const previous=old?.credentialId;let credentialId,created;
    if(draft){
      const same=old&&!input.ssh.forgetSecret&&old.method===draft.method&&old.host.toLowerCase()===draft.host.toLowerCase()&&old.username===draft.username&&(old.keyPath||'')===draft.keyPath;
      if(same)credentialId=previous;
      if(input.ssh.secret){created=randomUUID();await this.secrets('set',created,input.ssh.secret);credentialId=created;}
    }
    const logins=this.ssh.logins.filter(l=>l.id!==id);
    if(draft){const login={id,...draft,active:(this.ssh.modes?.[id]||(typeof input.preferSsh==='boolean'?(input.preferSsh?'ssh':'web'):old?(old.active?'ssh':'web'):hasWeb?'web':'ssh'))==='ssh'};if(credentialId)login.credentialId=credentialId;if(!hasWeb)Object.assign(login,{label,icon,note,hideAddress:input.hideAddress});logins.push(login);}
    const order=this.ssh.order.length&&!this.ssh.order.includes(id)?[...this.ssh.order,id]:this.ssh.order,next={schema:1,logins,order,...this.ssh.modes?{modes:this.ssh.modes}:{}};
    try{this.write('ssh-logins.json',next);}catch(e){if(created)await this.secrets('delete',created).catch(()=>{});throw e;}
    this.ssh=next;
    if(previous&&previous!==credentialId)await this.secrets('delete',previous).catch(()=>{});
  }
  async saveWeb(input,old,id,label,icon,note,detectShared){
    const url=normalizeUrl(input.url);
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
    const target={...old,id,url,label,icon,note,hideAddress:input.hideAddress,authMode,autoLogin:authMode==='shared-browser'&&input.autoLogin,changed:credentialsChanged?randomUUID():old.changed};
    if(credentialId)target.credentialId=credentialId;else delete target.credentialId;
    const next={...this.config,targets:old?this.targets.map(t=>t===old?target:t):[...this.targets,target]};
    try{this.write('targets.json',next);}catch(e){if(newCredential)await this.secrets('delete',newCredential).catch(()=>{});throw e;}
    this.config=next;
    if(previous&&previous!==credentialId)await this.secrets('delete',previous).catch(()=>{});
    return target.id;
  }
  setLogin(id,active){const login=this.sshFor(id);if((!login&&!this.targets.some(t=>t.id===id))||typeof active!=='boolean')throw Error('连接不存在');const next={...this.ssh,modes:{...this.ssh.modes,[id]:active?'ssh':'web'},logins:this.ssh.logins.map(l=>l===login?{...l,active}:l)};this.write('ssh-logins.json',next);this.ssh=next;}
  async remove(id){const old=this.targets.find(t=>t.id===id),login=this.sshFor(id);if(!old&&!login)throw Error('连接不存在');if(old)await this.dropWeb(old);const modes={...this.ssh.modes};delete modes[id];const next={...this.ssh,modes,logins:this.ssh.logins.filter(l=>l!==login),order:this.ssh.order.filter(item=>item!==id)};this.write('ssh-logins.json',next);this.ssh=next;if(login?.credentialId)await this.secrets('delete',login.credentialId).catch(()=>{});}
  reorder(ids){const known=[...this.targets,...this.sshOnly];if(!Array.isArray(ids)||ids.length!==known.length||new Set(ids).size!==ids.length||ids.some(id=>!known.some(t=>t.id===id)))throw Error('排序无效');const next={...this.config,targets:ids.map(id=>this.targets.find(t=>t.id===id)).filter(Boolean)};this.write('targets.json',next);this.config=next;if(this.ssh.logins.length){const ssh={...this.ssh,order:ids};this.write('ssh-logins.json',ssh);this.ssh=ssh;}}
  settings(value){const next={...this.preferences,...value,schema:1};this.validatePreferences(next);this.write('application-preferences.json',next);this.preferences=next;}
  async password(id){const target=this.targets.find(t=>t.id===id);if(!target)throw Error('连接不存在');return this.secrets('get',target.credentialId||target.id);}
}
