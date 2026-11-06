// One device's SSH details and terminal launch. A separate SSH MCP worker is
// prepared first; the visible shell never carries tool packets. Nothing secret reaches a command line
// or the script: a saved password stays in Keychain and reaches ssh through SSH_ASKPASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicWrite,privateDir,safeFile,KIT,runFile} from './platform.mjs';
import {listProcesses} from './browsers.mjs';

export const VARIABLE='CMCP_SSH_ASKPASS';
// Each value reaches a command line, so nothing may look like an option or a separator.
export function validHost(value){
  if(typeof value!=='string'||!value||value.length>253)return false;
  return value.includes(':')?/^[0-9A-Fa-f:.]+$/.test(value):/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}
export const validUser=value=>typeof value==='string'&&value.length>0&&value.length<=64&&/^[A-Za-z0-9_][A-Za-z0-9._@-]*$/.test(value);
export const validKeyPath=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&path.isAbsolute(value)&&!/[\u0000-\u001f\u007f]/.test(value);
// Empty when usable, otherwise the message for the editor.
export function sshProblem({host,port,username,method,keyPath}){
  if(!validHost(host))return '请输入正确的主机地址（域名或 IP）。';
  const number=Number(port);if(!Number.isInteger(number)||number<1||number>65535)return '端口必须是 1 到 65535 之间的数字。';
  if(!validUser(username))return '请输入正确的用户名。';
  if(method!=='password'&&method!=='key')return '认证方法无效。';
  if(method==='key'&&!validKeyPath(keyPath))return '请选择私钥文件。';
  return '';
}
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
// Only what is really installed is offered. Terminal ships with macOS.
const KNOWN=[['terminal','Terminal','/System/Applications/Utilities/Terminal.app'],['iterm','iTerm2','/Applications/iTerm.app'],['ghostty','Ghostty','/Applications/Ghostty.app'],['wezterm','WezTerm','/Applications/WezTerm.app'],['kitty','kitty','/Applications/kitty.app'],['alacritty','Alacritty','/Applications/Alacritty.app']];
export function detectTerminals(exists=fs.existsSync,home=os.homedir()){
  const found=[];
  for(const [id,label,where]of KNOWN){
    const own=path.join(home,'Applications',path.basename(where)),app=[where,own].find(candidate=>exists(candidate));
    if(app)found.push({id,label,path:app});
  }
  return found;
}
// A saved choice that was uninstalled later falls back to the first one found.
export const resolveTerminal=(id,found)=>found.find(item=>item.id===id)||found[0]||null;
// A saved password may answer one prompt only, so a wrong one cannot lock the account out.
// Without a saved secret ssh simply asks in the terminal.
export function sshOptions(login){
  const options=['-p',String(login.port),'-l',login.username];
  if(login.method==='key')options.push('-i',login.keyPath,'-o','IdentitiesOnly=yes');
  else if(login.credentialId)options.push('-o','PubkeyAuthentication=no','-o','PreferredAuthentications=keyboard-interactive,password','-o','NumberOfPasswordPrompts=1');
  options.push('--',login.host);
  return options;
}
// Where a terminal that closes on disconnect records the PID of its script.
export const sessionsFolder=(directory,id)=>path.join(directory,'ssh-sessions',createHash('sha256').update(String(id)).digest('hex').slice(0,16));
// The shell stays open afterwards; another ssh typed there must not receive this device's password.
// With sessions the script ends with ssh instead, so the window can close. A record that
// closeSessions removed means a disconnect; a failed login otherwise waits for Enter.
export function commandScript(login,{askpass,state,ssh='/usr/bin/ssh',mcp,sessions,ended='SSH 已结束，按回车键关闭窗口'}={}){
  const secret=!!login.credentialId||!!mcp,lines=['#!/bin/sh','rm -f "$0"',`printf '\\033]0;%s\\007' ${quote(login.username+'@'+login.host)}`];
  if(sessions)lines.push(`cmcp_session=${quote(sessions)}/$$.pid`,': > "$cmcp_session"');
  if(secret)lines.push(`export SSH_ASKPASS=${quote(askpass)} SSH_ASKPASS_REQUIRE=force ${VARIABLE}=${quote(login.id)} CMCP_STATE_DIR=${quote(state)}`);
  if(mcp)lines.push([mcp.node,mcp.script,'--state',state,'--id',login.id,'--owner',String(mcp.owner),'--ssh',ssh].map(quote).join(' ')+" || printf '%s\\n' 'MCP 尚未就绪；仍可进入 SSH 终端检查服务器。'");
  lines.push([ssh,...sshOptions(login)].map(quote).join(' '));
  if(sessions)lines.push('cmcp_code=$?');
  if(secret)lines.push(`unset SSH_ASKPASS SSH_ASKPASS_REQUIRE ${VARIABLE}`);
  if(sessions)lines.push(`if [ -e "$cmcp_session" ]; then rm -f "$cmcp_session"; [ "$cmcp_code" -eq 0 ] || { printf '\\n%s ' ${quote(ended)}; read cmcp_line; }; fi`,'exit 0','');
  else lines.push('exec "${SHELL:-/bin/zsh}" -l','');
  return lines.join('\n');
}
export function openArguments(terminal,script){
  switch(terminal.id){
    case 'ghostty':case 'alacritty':return ['-n','-a',terminal.path,'--args','-e',script];
    case 'wezterm':return ['-n','-a',terminal.path,'--args','start','--',script];
    case 'kitty':return ['-n','-a',terminal.path,'--args',script];
    default:return ['-a',terminal.path,script];
  }
}
function clearOld(folder,now=Date.now()){try{for(const name of fs.readdirSync(folder)){const file=path.join(folder,name);if(name.endsWith('.command')&&now-fs.statSync(file).mtimeMs>3600000)fs.unlinkSync(file);}}catch{}}
// The script deletes itself when it starts. A small wrapper is needed because ssh runs SSH_ASKPASS with no arguments of its own.
export function writeLaunch(login,directory,{node=process.execPath,kit=KIT,owner=process.pid,prepareMcp=true,closeTerminal=false}={}){
  const folder=privateDir(path.join(directory,'ssh-run'));clearOld(folder);
  let askpass;
  if(login.credentialId||prepareMcp){
    askpass=path.join(directory,'ssh-askpass');
    atomicWrite(askpass,`#!/bin/sh\nexec ${quote(node)} ${quote(path.join(kit,'ssh-askpass.mjs'))} "$1"\n`,0o700);
    fs.chmodSync(askpass,0o700);
  }
  const script=path.join(folder,randomUUID()+'.command');
  const mcp=prepareMcp?{node,script:path.join(kit,'../app/ssh-terminal.mjs'),owner}:undefined;
  const sessions=closeTerminal?privateDir(sessionsFolder(directory,login.id)):undefined;
  const ended=readLanguage(directory)==='en'?'SSH ended. Press Enter to close this window':'SSH 已结束，按回车键关闭窗口';
  atomicWrite(script,commandScript(login,{askpass,state:directory,mcp,sessions,ended}),0o700);fs.chmodSync(script,0o700);
  return script;
}
export async function openTerminal(login,directory,chosen,{found=detectTerminals(),run=runFile,closeTerminal=false}={}){
  const terminal=resolveTerminal(chosen,found);if(!terminal)throw Error('无法打开所选终端，请在设置中换一个终端后重试。');
  const script=writeLaunch(login,directory,{closeTerminal});
  try{await run('/usr/bin/open',openArguments(terminal,script));}
  catch{try{fs.unlinkSync(script);}catch{}throw Error('无法打开所选终端，请在设置中换一个终端后重试。');}
  return terminal.id;
}
// Ends the ssh of every recorded terminal of this device and returns how many ended. The record
// goes first, so the script knows it was a disconnect and closes without waiting for a key.
export async function closeSessions(directory,id,{list=listProcesses,kill=(pid,signal)=>process.kill(pid,signal)}={}){
  const folder=sessionsFolder(directory,id),scripts=path.join(directory,'ssh-run');let names;
  try{names=fs.readdirSync(folder).filter(name=>/^\d+\.pid$/.test(name));}catch{return 0;}
  if(!names.length)return 0;
  const processes=await list();let closed=0;
  for(const name of names){
    const pid=Number(name.slice(0,-4)),shell=processes.find(item=>item.pid===pid);
    try{fs.unlinkSync(path.join(folder,name));}catch{}
    // A PID a later program took over is not this terminal: the script runs from ssh-run.
    if(!shell||!shell.command.includes(scripts))continue;
    for(const child of processes.filter(item=>item.ppid===pid&&path.basename(item.command.split(' ')[0])==='ssh')){try{kill(child.pid,'SIGTERM');closed++;}catch{}}
  }
  return closed;
}
// The saved secret only answers the exact prompt for this device. Anything else goes to the user.
export function classify(prompt,login){
  const text=String(prompt||'').trim();
  if(/\(yes\/no/i.test(text))return 'confirm';
  if(!login?.credentialId)return 'ask';
  if(login.method==='key'){
    if(/^Enter passphrase:$/i.test(text))return 'secret';
    return /^Enter passphrase/i.test(text)&&text.includes(login.keyPath)?'secret':'ask';
  }
  const who=(login.username+'@'+login.host).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`^(?:${who}'s password:|\\(${who}\\) ?Password:|Password:)$`,'i').test(text)?'secret':'ask';
}
export function readLogin(directory,id){
  const file=path.join(directory,'ssh-logins.json');safeFile(file);
  try{return JSON.parse(fs.readFileSync(file,'utf8')).logins.find(item=>item.id===id)||null;}catch{return null;}
}
function readLanguage(directory){try{return JSON.parse(fs.readFileSync(path.join(directory,'application-preferences.json'),'utf8')).language==='en'?'en':'zh-CN';}catch{return 'zh-CN';}}
// Always answered by a person: an unknown host key, a one-time code, a password nothing was saved for.
const SCRIPT=`on run argv
  set message to item 1 of argv
  if item 2 of argv is "ask" then
    set reply to display dialog message default answer "" with hidden answer with title "CMCP · SSH" buttons {item 3 of argv, item 4 of argv} default button 2 cancel button 1
    return text returned of reply
  end if
  display dialog message with title "CMCP · SSH" buttons {item 3 of argv, item 4 of argv} default button 1 cancel button 1
  return "yes"
end run`;
export async function dialog(message,kind,language,run=runFile){
  const words=language==='en'?{cancel:'Cancel',ok:kind==='ask'?'OK':'Trust and continue',check:"Check this server's fingerprint. The connection continues only after you confirm:"}:{cancel:'取消',ok:kind==='ask'?'确定':'信任并继续',check:'请核对这台服务器的指纹，确认后才会继续连接：'};
  const text=kind==='ask'?message:words.check+'\n\n'+message;
  try{return String(await run('/usr/bin/osascript',['-e',SCRIPT,text,kind,words.cancel,words.ok],{timeout:600000})).replace(/\n$/,'');}catch{return null;}
}
// What ssh's helper program prints and exits with.
export async function answerPrompt({prompt,id,style='',directory,secrets,ask=dialog}){
  const language=readLanguage(directory),login=readLogin(directory,id);
  if(style==='none')return {code:0,output:''};
  if(style==='confirm')return {code:await ask(prompt,'confirm',language)===null?1:0,output:''};
  let kind=classify(prompt,login);
  if(kind==='secret'){
    try{return {code:0,output:await secrets('get',login.credentialId)+'\n'};}catch{kind='ask';}
  }
  if(kind==='confirm')return {code:0,output:(await ask(prompt,'confirm',language)===null?'no':'yes')+'\n'};
  const typed=await ask(prompt,'ask',language);
  return typed===null?{code:1,output:''}:{code:0,output:typed+'\n'};
}
