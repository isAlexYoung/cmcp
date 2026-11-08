import {webTunnelTargets,tunnelName,tunnelIdentity} from '../app/ssh-web.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicWrite, privateDir, safeFile, readConfig, normalizeUrl, STATE} from './platform.mjs';
import {sshProblem} from './ssh.mjs';
import {cloudcliName,cloudcliTargets,cloudcliOrigin} from '../app/cloudcli.mjs';

const iconPattern = /^data:image\/(?:png|jpeg|x-icon|vnd.microsoft.icon);base64,[A-Za-z0-9+/=]+$/;
export class ManagerState {
  constructor(directory=STATE, secrets) {
    this.directory=privateDir(directory);this.secrets=secrets;
    this.config=readConfig(directory);this.chain=Promise.resolve();
    this.preferences=this.read('application-preferences.json',{schema:1,language:'zh-CN',theme:'system',autoStart:false,closeAction:'tray',shortcutPrompt:true});
    this.controls=this.read('target-controls.json',{schema:1,targets:this.config.targets.map(t=>({name:t.id,enabled:false,revision:randomUUID(),requestTime:'0'}))});
    this.ssh=this.read('ssh-logins.json',{schema:1,logins:[],order:[]});
    this.cloudcli=this.read('cloudcli-logins.json',{schema:1,logins:[]});this.validateCloudcli();
    this.validateControls();this.validatePreferences(this.preferences);this.validateSsh();
  }
  read(name,fallback) {const file=path.join(this.directory,name);safeFile(file);try{if(fs.statSync(file).size>2*1024*1024)throw Error('Local state too large');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('本地设置损坏，原文件已保留');}}
  write(name,value){atomicWrite(path.join(this.directory,name),JSON.stringify(value,null,2));}
  serial(action){const promise=this.chain.then(action);this.chain=promise.catch(()=>{});return promise;}
  validateControls(){if(this.controls.schema!==1||!Array.isArray(this.controls.targets)||this.controls.targets.length>400)throw Error('Invalid controls');const seen=new Set();for(const t of this.controls.targets){if(typeof t.name!=='string'||seen.has(t.name)||typeof t.enabled!=='boolean'||typeof t.revision!=='string')throw Error('Invalid controls');seen.add(t.name);}}
  validatePreferences(p){if(p.schema!==1||!['zh-CN','en'].includes(p.language)||!['light','dark','system'].includes(p.theme)||!['tray','exit'].includes(p.closeAction)||typeof p.autoStart!=='boolean'||typeof p.shortcutPrompt!=='boolean'||(p.terminal!==undefined&&(typeof p.terminal!=='string'||p.terminal.length>32))||(p.browser!==undefined&&(typeof p.browser!=='string'||p.browser.length>32))||(p.closeWeb!==undefined&&typeof p.closeWeb!=='boolean')||(p.cloudcliBrowser!==undefined&&(typeof p.cloudcliBrowser!=='string'||p.cloudcliBrowser.length>32))||(p.closeCloudcli!==undefined&&typeof p.closeCloudcli!=='boolean')||(p.closeTerminal!==undefined&&typeof p.closeTerminal!=='boolean'))throw Error('设置格式无效');}
  // SSH details stay out of web targets; the independent SSH MCP worker reads them.
  validateSsh(){const s=this.ssh;if(s.routes!==undefined&&(!s.routes||typeof s.routes!=='object'||Array.isArray(s.routes)||Object.keys(s.routes).length>100||Object.values(s.routes).some(r=>!r||typeof r!=='object'||Object.keys(r).some(app=>!['web','cloudcli'].includes(app))||Object.values(r).some(v=>!['url','ssh'].includes(v)))))throw Error('Invalid SSH routes');if(s.schema!==1||!Array.isArray(s.logins)||!Array.isArray(s.order)||s.logins.length>100)throw Error('本地设置损坏，原文件已保留');if([...this.targets,...s.logins].some(t=>!t||(t.hideAddress!==undefined&&typeof t.hideAddress!=="boolean")))throw Error("本地设置损坏，原文件已保留");if(s.modes!==undefined&&(!s.modes||typeof s.modes!=="object"||Array.isArray(s.modes)||Object.keys(s.modes).length>100||Object.entries(s.modes).some(([id,mode])=>!/^[a-f0-9-]{36}$/.test(id)||!["web","cloudcli","ssh"].includes(mode))))throw Error("本地设置损坏，原文件已保留");const seen=new Set();for(const l of s.logins){if(!l||!/^[a-f0-9-]{36}$/.test(l.id)||seen.has(l.id)||sshProblem(l)||(l.credentialId!==undefined&&!/^[a-f0-9-]{36}$/.test(l.credentialId)))throw Error('本地设置损坏，原文件已保留');seen.add(l.id);}}
  loginMode(id){return this.ssh.modes?.[id]||(this.sshFor(id)?.active?'ssh':this.targets.some(t=>t.id===id)?'web':this.sshFor(id)?'ssh':this.cloudcliFor(id)?'cloudcli':'web');}
  route(id,app=this.loginMode(id)){return app==='ssh'?'ssh':this.ssh.routes?.[id]?.[app]||'url';}
  connectionName(id){const app=this.loginMode(id);return app!=='ssh'&&this.route(id,app)==='ssh'?tunnelName(id,app):app==='cloudcli'?cloudcliName(id):id;}
  setRoute(id,route){if(!['url','ssh'].includes(route)||!this.view().targets.some(t=>t.id===id))throw Error('连接方式无效');let app=this.loginMode(id);const terminal=app==='ssh';if(terminal&&route==='ssh')return;if(terminal)app=this.targets.some(t=>t.id===id)?'web':this.cloudcliFor(id)?'cloudcli':'web';const next={...this.ssh,...terminal?{modes:{...this.ssh.modes,[id]:app},logins:this.ssh.logins.map(l=>l.id===id?{...l,active:false}:l)}:{},routes:{...this.ssh.routes,[id]:{...this.ssh.routes?.[id],[app]:route}}};this.write('ssh-logins.json',next);this.ssh=next;}
  cloudcliFor(id){return this.cloudcli.logins.find(l=>l.id===id)||null;}
  validateCloudcli(){if(this.cloudcli.schema!==1||!Array.isArray(this.cloudcli.logins)||this.cloudcli.logins.length>100)throw Error('CloudCLI 配置损坏，原文件已保留。');const seen=new Set();for(const l of this.cloudcli.logins){if(!l||typeof l.id!=='string'||seen.has(l.id)||typeof l.autoLogin!=='boolean'||(l.credentialId!==undefined&&!/^[a-f0-9-]{36}$/.test(l.credentialId)))throw Error('CloudCLI 配置损坏，原文件已保留。');cloudcliOrigin(l.url);seen.add(l.id);}}
  sshFor(id){return this.ssh.logins.find(l=>l.id===id)||null;}
  get sshOnly(){return this.ssh.logins.filter(l=>!this.targets.some(t=>t.id===l.id));}
  sshView(login){if(!login)return null;return {host:login.host,port:login.port,username:login.username,method:login.method,keyPath:login.keyPath||'',hasSecret:!!login.credentialId,active:this.loginMode(login.id)==='ssh',address:login.username+'@'+login.host+':'+login.port,webTunnel:login.webTunnel===true,cloudcliTunnel:login.cloudcliTunnel===true,webPort:login.webPort??3000,cloudcliPort:login.cloudcliPort??3001,webAutoLogin:login.webAutoLogin===true,cloudcliAutoLogin:login.cloudcliAutoLogin===true,webHasPassword:!!login.webCredentialId,cloudcliHasPassword:!!login.cloudcliCredentialId,command:'ssh -p '+login.port+(login.method==='key'?' -i "'+login.keyPath+'"':'')+' '+login.username+'@'+login.host};}
  ordered(list){const rank=new Map(this.ssh.order.map((id,i)=>[id,i])),at=item=>rank.has(item.id)?rank.get(item.id):Infinity;return list.map((item,i)=>[item,i]).sort(([a,i],[b,j])=>at(a)===at(b)?i-j:at(a)-at(b)).map(([item])=>item);}
  get targets(){return this.config.targets;}
  controlMap(){return new Map(this.controls.targets.map(t=>[t.name,t]));}
  linkTargets(){return [...this.targets.map(t=>({name:t.id,url:t.url,stamp:t.changed,authMode:t.authMode,autoLogin:t.autoLogin===true})),...cloudcliTargets(this.cloudcli.logins),...webTunnelTargets(this.ssh.logins)];}
  view(states={}){
    const web=this.targets.map(t=>{const enabled=this.controlMap().get(t.id)?.enabled===true;return {id:t.id,url:t.url,label:t.label||new URL(t.url).hostname,icon:t.icon||'',note:t.note||'',hideAddress:t.hideAddress===true,customLabel:!!t.label,autoLogin:t.autoLogin===true,authMode:t.authMode||'legacy',hasSavedPassword:!!(t.credentialId||!t.authMode),enabled,...(enabled?(states[t.id]||{state:'connecting',message:'正在连接'}):{state:'stopped',message:'已停止'})};});
    const extras=[...this.sshOnly,...this.cloudcli.logins.filter(l=>!this.targets.some(t=>t.id===l.id)&&!this.sshOnly.some(t=>t.id===l.id))];
    const only=extras.map(l=>({id:l.id,url:'',label:l.label||l.host||new URL(l.url).hostname,icon:l.icon||'',note:l.note||'',hideAddress:l.hideAddress===true,customLabel:!!l.label,autoLogin:false,authMode:'ssh',hasSavedPassword:false,enabled:false,state:'stopped',message:'已停止'}));
    const targets=[...web,...only].map(t=>{const l=this.cloudcliFor(t.id),enabled=l&&this.controlMap().get(cloudcliName(t.id))?.enabled===true;return {...t,ssh:this.sshView(this.sshFor(t.id)),loginMode:this.loginMode(t.id),route:this.route(t.id),tunnels:Object.fromEntries(['web','cloudcli'].map(app=>{const name=tunnelName(t.id,app),configured=this.sshFor(t.id)?.[app+'Tunnel']===true,enabled=configured&&this.controlMap().get(name)?.enabled===true;return [app,{url:configured?'http://127.0.0.1:'+(this.sshFor(t.id)[app+'Port']??(app==='web'?3000:3001)):'',enabled,...enabled?(states[name]||{state:'connecting',message:'正在建立 SSH 隧道'}):{state:'stopped',message:'已停止'}}];})),cloudcli:l?{url:l.url,autoLogin:l.autoLogin,hasSavedPassword:!!l.credentialId,enabled,...(enabled?(states[cloudcliName(t.id)]||{state:'connecting',message:'正在连接'}):{state:'stopped',message:'已停止'})}:null};});
    return {preferences:this.preferences,targets:this.ordered(targets)};
  }
  setEnabled(id,enabled,mode=this.loginMode(id)){
    const name=id===null?null:mode===this.loginMode(id)?this.connectionName(id):mode==='cloudcli'?cloudcliName(id):id,known=this.linkTargets();
    if(name!==null&&!known.some(t=>t.name===name))throw Error(this.route(id,mode)==='ssh'?'还没有配置此打开对象的 SSH 隧道，请编辑设备后再连接。':mode==='cloudcli'?'还没有填写 CloudCLI 地址，请编辑设备后再连接。':this.sshFor(id)||this.cloudcliFor(id)?'还没有填写网页桌面地址，请编辑设备后再连接。':'连接不存在');
    const before=this.controlMap();this.controls={schema:1,targets:known.map(t=>{const previous=before.get(t.name),selected=id===null||t.name===name;return {name:t.name,enabled:selected?enabled:previous?.enabled===true,revision:selected?randomUUID():previous?.revision||randomUUID(),requestTime:String(Date.now())};})};this.write('target-controls.json',this.controls);
  }
  sshDraft(value){
    if(!value||typeof value!=='object'||(value.secret!==undefined&&(typeof value.secret!=='string'||value.secret.length>256)))throw Error('请输入正确的主机地址（域名或 IP）。');
    const draft={host:String(value.host??'').trim(),port:Number(String(value.port??'').trim()),username:String(value.username??'').trim(),method:value.method,keyPath:value.method==='key'?String(value.keyPath??'').trim():''};
    const problem=sshProblem(draft);if(problem)throw Error(problem);
    if(draft.method==='key'){if(draft.keyPath.toLowerCase().endsWith('.pub'))throw Error('这是公钥文件，请选择不带 .pub 的私钥文件。');if(!fs.existsSync(draft.keyPath))throw Error('找不到这个私钥文件。');}
    return draft;
  }
  async save(input,detectShared){
    const names=['targets.json','ssh-logins.json','cloudcli-logins.json','target-controls.json'],files=new Map(names.map(name=>{const file=path.join(this.directory,name);safeFile(file);return [name,fs.existsSync(file)?fs.readFileSync(file):null];}));
    const snapshot=JSON.parse(JSON.stringify({config:this.config,ssh:this.ssh,cloudcli:this.cloudcli,controls:this.controls})),secrets=this.secrets,created=[],removed=[];
    this.secrets=async(op,id,value)=>{if(op==='delete'){removed.push(id);return;}const result=await secrets(op,id,value);if(op==='set')created.push(id);return result;};
    try{const id=await this.saveDevice(input,detectShared);this.secrets=secrets;await Promise.allSettled(removed.map(id=>secrets('delete',id)));return id;}
    catch(error){this.secrets=secrets;Object.assign(this,snapshot);for(const [name,bytes]of files){const file=path.join(this.directory,name);if(bytes===null){if(fs.existsSync(file)){safeFile(file);fs.unlinkSync(file);}}else atomicWrite(file,bytes);}await Promise.allSettled(created.map(id=>secrets('delete',id)));throw error;}
    finally{this.secrets=secrets;}
  }
  async saveDevice(input,detectShared){
    if(!input||typeof input!=='object')throw Error('Invalid target');
    const old=input.id?this.targets.find(t=>t.id===input.id):null,oldLogin=input.id?this.sshFor(input.id):null,oldCloud=input.id?this.cloudcliFor(input.id):null;
    if(input.id&&!old&&!oldLogin&&!oldCloud)throw Error('连接不存在');
    // Older callers send no ssh field and always mean a web address.
    const sshGiven=input.ssh!==undefined,cloudGiven=input.cloudcli!==undefined,wantsWeb=!sshGiven&&!cloudGiven||String(input.url??'').trim()!=='';
    if(cloudGiven)this.cloudcliDraft(input.cloudcli,oldCloud,input.id);
    if(sshGiven&&!wantsWeb&&!input.ssh&&!input.cloudcli)throw Error('请至少填写一种登录方式：网页桌面地址或 SSH 主机。');
    const hideAddress=input.hideAddress===undefined?(old?.hideAddress??oldLogin?.hideAddress??oldCloud?.hideAddress??false):input.hideAddress;if(typeof hideAddress!=='boolean')throw Error('显示设置无效');input={...input,hideAddress};
    const label=String(input.label||'').trim(),icon=input.icon||'',note=typeof input.note==='string'?input.note.trim():old?.note||oldCloud?.note||'';
    if(label.length>100||typeof icon!=='string'||icon.length>350000||(icon&&!iconPattern.test(icon)))throw Error('名称或图标无效');
    if(note.length>200||/[\u0000-\u0009\u000b\u000c\u000e-\u001f]/.test(note))throw Error('备注不能包含控制字符。');
    if(!old&&!oldLogin&&!oldCloud&&this.view().targets.length>=100)throw Error('最多保存 100 台设备。');
    const id=old?.id||oldLogin?.id||oldCloud?.id||randomUUID(),draft=sshGiven&&input.ssh?this.sshDraft(input.ssh):null;
    if(!wantsWeb&&old&&this.controlMap().get(id)?.enabled)throw Error('请先停止此连接，再删除网页桌面登录。');
    if(wantsWeb)await this.saveWeb(input,old,id,label,icon,note,detectShared);
    else if(old)await this.dropWeb(old);
    if(sshGiven)await this.saveSsh(id,input,draft,oldLogin,wantsWeb,label,icon,note);
    if(cloudGiven)await this.saveCloudcli(id,input.cloudcli,oldCloud,label,icon,note,input.hideAddress);
    else if(oldCloud){await this.saveCloudcli(id,{url:oldCloud.url,password:'',autoLogin:oldCloud.autoLogin},oldCloud,label,icon,note,input.hideAddress);}
    if(!old&&!oldLogin&&!oldCloud&&!wantsWeb&&!input.cloudcli&&draft&&(input.ssh.webTunnel||input.ssh.cloudcliTunnel)){this.setLogin(id,input.ssh.webTunnel?'web':'cloudcli');this.setRoute(id,'ssh');}
    return id;
  }
  async dropWeb(old){this.setEnabled(old.id,false);const next={...this.config,targets:this.targets.filter(t=>t!==old)};this.write('targets.json',next);this.config=next;const ref=old.credentialId||(!old.authMode?old.id:null);if(ref)await this.secrets('delete',ref).catch(()=>{});}
  // A saved secret is kept only for the same server, user and method, so it can never reach a server just typed in.
  async saveSsh(id,input,draft,old,hasWeb,label,icon,note){
    const previous=old?.credentialId;let credentialId,created;
    if(old&&['web','cloudcli'].some(app=>this.controlMap().get(tunnelName(id,app))?.enabled)&&!draft)throw Error('请先停止此设备的 SSH 隧道，再修改连接信息。');
    if(draft){
      const same=old&&!input.ssh.forgetSecret&&old.method===draft.method&&old.host.toLowerCase()===draft.host.toLowerCase()&&old.username===draft.username&&(old.keyPath||'')===draft.keyPath;
      if(same)credentialId=previous;
      if(input.ssh.secret){created=randomUUID();await this.secrets('set',created,input.ssh.secret);credentialId=created;}
    }
    const logins=this.ssh.logins.filter(l=>l.id!==id);
    if(draft){const login={id,...draft,active:(this.ssh.modes?.[id]||(typeof input.preferSsh==='boolean'?(input.preferSsh?'ssh':'web'):old?(old.active?'ssh':'web'):hasWeb?'web':'ssh'))==='ssh'};if(credentialId)login.credentialId=credentialId;
      for(const app of ['web','cloudcli']){const enabled=input.ssh[app+'Tunnel']===true,port=Number(input.ssh[app+'Port']??old?.[app+'Port']??(app==='web'?3000:3001)),auto=input.ssh[app+'AutoLogin']===true,typed=input.ssh[app+'Password']||'';if(!Number.isInteger(port)||port<1||port>65535||typeof typed!=='string'||typed.length>256)throw Error('网页服务端口或密码无效');
        const same=old&&old.host===draft.host&&old.port===draft.port&&old.username===draft.username&&(old[app+'Port']??(app==='web'?3000:3001))===port;let ref=auto&&same?old[app+'CredentialId']:undefined;if(auto&&typed){ref=randomUUID();await this.secrets('set',ref,typed);}if(enabled&&auto&&!ref)throw Error('请填写自动登录的网页访问密码；更换服务器或端口时需要重新填写。');
        Object.assign(login,{[app+'Tunnel']:enabled,[app+'Port']:port,[app+'AutoLogin']:auto,...ref?{[app+'CredentialId']:ref}:{}});if(old?.[app+'CredentialId']&&old[app+'CredentialId']!==ref)await this.secrets('delete',old[app+'CredentialId']);
      }
      if(login.webPort===login.cloudcliPort)throw Error('WebDesktop 和 CloudCLI 的服务端口必须不同。');
      const enabledTunnel=['web','cloudcli'].some(app=>this.controlMap().get(tunnelName(id,app))?.enabled);if(enabledTunnel&&(!!input.ssh.secret||draft.host!==old.host||draft.port!==old.port||draft.username!==old.username||draft.method!==old.method||draft.keyPath!==(old.keyPath||'')||['web','cloudcli'].some(app=>!!input.ssh[app+'Password']||login[app+'Tunnel']!==old[app+'Tunnel']||login[app+'Port']!==(old[app+'Port']??(app==='web'?3000:3001))||login[app+'AutoLogin']!==old[app+'AutoLogin'])))throw Error('请先停止此设备的 SSH 隧道，再修改连接信息。');
      if(!hasWeb)Object.assign(login,{label,icon,note,hideAddress:input.hideAddress});logins.push(login);}
    const order=this.ssh.order.length&&!this.ssh.order.includes(id)?[...this.ssh.order,id]:this.ssh.order,next={...this.ssh,schema:1,logins,order};
    try{this.write('ssh-logins.json',next);}catch(e){if(created)await this.secrets('delete',created).catch(()=>{});throw e;}
    this.ssh=next;
    if(previous&&previous!==credentialId)await this.secrets('delete',previous).catch(()=>{});if(!draft&&old)await Promise.all(['web','cloudcli'].map(app=>old[app+'CredentialId']?this.secrets('delete',old[app+'CredentialId']):null));
  }
  cloudcliDraft(value,old,id){
    if(value!==null){if(!value||typeof value!=='object'||typeof value.password!=='string'||value.password.length>256||typeof value.autoLogin!=='boolean')throw Error('CloudCLI 密码或登录设置无效。');const url=cloudcliOrigin(value.url);if(this.cloudcli.logins.some(l=>l.id!==id&&l.url===url))throw Error('该 CloudCLI 地址已添加。');if(value.autoLogin&&!value.password&&(!old?.credentialId||old.url!==url))throw Error('请填写 CloudCLI 自动登录密码；更换地址时需要重新填写。');}
    if(old&&this.controlMap().get(cloudcliName(id))?.enabled&&(value===null||old.url!==cloudcliOrigin(value.url)||!!value.password||value.autoLogin!==old.autoLogin))throw Error('请先停止 CloudCLI 连接，再修改地址、密码或自动登录。');
  }
  async saveCloudcli(id,value,old,label,icon,note,hideAddress){
    this.cloudcliDraft(value,old,id);let created,credentialId=value?.autoLogin&&old?.url===cloudcliOrigin(value.url)?old.credentialId:undefined;
    if(value?.autoLogin&&value.password){created=randomUUID();await this.secrets('set',created,value.password);credentialId=created;}
    const record=value?{id,url:cloudcliOrigin(value.url),autoLogin:value.autoLogin,...credentialId?{credentialId}:{},label,icon,note,hideAddress}:null;
    const logins=this.cloudcli.logins.flatMap(l=>l.id===id?record?[record]:[]:[l]);if(record&&!old)logins.push(record);
    const next={schema:1,logins};try{this.write('cloudcli-logins.json',next);}catch(error){if(created)await this.secrets('delete',created).catch(()=>{});throw error;}this.cloudcli=next;
    if(old?.credentialId&&old.credentialId!==credentialId)await this.secrets('delete',old.credentialId).catch(()=>{});
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
  setLogin(id,active){if(typeof active!=='boolean'&&typeof active!=='string')throw Error('连接不存在');const login=this.sshFor(id),mode=typeof active==='string'?active:active?'ssh':'web';if((!login&&!this.targets.some(t=>t.id===id)&&!this.cloudcliFor(id))||!['web','cloudcli','ssh'].includes(mode))throw Error('连接不存在');const next={...this.ssh,modes:{...this.ssh.modes,[id]:mode},logins:this.ssh.logins.map(l=>l===login?{...l,active:mode==='ssh'}:l)};this.write('ssh-logins.json',next);this.ssh=next;}
  async remove(id){const old=this.targets.find(t=>t.id===id),login=this.sshFor(id);const cloud=this.cloudcliFor(id);if(!old&&!login&&!cloud)throw Error('连接不存在');if(cloud){this.setEnabled(id,false,'cloudcli');await this.saveCloudcli(id,null,cloud,'','','',false);}if(old)await this.dropWeb(old);const modes={...this.ssh.modes};delete modes[id];const next={...this.ssh,modes,logins:this.ssh.logins.filter(l=>l!==login),order:this.ssh.order.filter(item=>item!==id)};this.write('ssh-logins.json',next);this.ssh=next;await Promise.allSettled([login?.credentialId,login?.webCredentialId,login?.cloudcliCredentialId].filter(Boolean).map(ref=>this.secrets('delete',ref)));}
  reorder(ids){const known=this.view().targets;if(!Array.isArray(ids)||ids.length!==known.length||new Set(ids).size!==ids.length||ids.some(id=>!known.some(t=>t.id===id)))throw Error('排序无效');const next={...this.config,targets:ids.map(id=>this.targets.find(t=>t.id===id)).filter(Boolean)};this.write('targets.json',next);this.config=next;if(this.ssh.logins.length||this.cloudcli.logins.length){const ssh={...this.ssh,order:ids};this.write('ssh-logins.json',ssh);this.ssh=ssh;}}
  settings(value){const next={...this.preferences,...value,schema:1};this.validatePreferences(next);this.write('application-preferences.json',next);this.preferences=next;}
  async password(id){const tunnel=tunnelIdentity(id);if(tunnel){const login=this.sshFor(tunnel.id);return this.secrets('get',login?.[tunnel.app+'CredentialId']);}const target=id.startsWith('cloudcli:')?this.cloudcliFor(id.slice(9)):this.targets.find(t=>t.id===id);if(!target)throw Error('连接不存在');return this.secrets('get',target.credentialId||target.id);}
}
