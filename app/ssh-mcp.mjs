// SSH carries the existing relay protocol over a dedicated non-interactive channel.
// The visible terminal is a separate SSH connection and never carries tool packets.
import fs from 'node:fs';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {TerminalLink} from './terminal-link.mjs';
import {RequestRecovery} from './request-recovery.mjs';

export const sshConnectorName = key => 'cmcp-ssh-'+createHash('sha256').update(key).digest('hex').slice(0,16);
const quote = value => "'"+String(value).replace(/'/g,"'\\''")+"'";
export function sshArguments(login, {background=false}={}) {
  if(typeof login?.host!=='string'||!(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(login.host)||/^[0-9a-fA-F:.]+$/.test(login.host))||login.host.length>253
    ||typeof login.username!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/.test(login.username)
    ||!Number.isInteger(login.port)||login.port<1||login.port>65535||!['key','password'].includes(login.method))throw Error('Invalid SSH profile');
  const args=['-p',String(login.port),'-l',login.username];
  if(login.method==='key') {
    if(typeof login.keyPath!=='string'||!login.keyPath||/[\x00-\x1f\x7f]/.test(login.keyPath))throw Error('Invalid SSH key path');
    args.push('-i',login.keyPath,'-o','IdentitiesOnly=yes');
  } else if(login.secret||login.credentialId) args.push('-o','PubkeyAuthentication=no','-o','PreferredAuthentications=keyboard-interactive,password');
  args.push('-o','NumberOfPasswordPrompts=1','-o','ForwardAgent=no','-o','ClearAllForwardings=yes');
  if(background)args.push('-T','-o','ConnectTimeout=30','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3');
  args.push('--',login.host);
  return args;
}

export function bootstrapPayload(key, catalog,platform=process.platform) {
  return {name:sshConnectorName(key), catalog,
    relay:fs.readFileSync(new URL('./cloudpc-relay.py',import.meta.url),'utf8'),
    connector:fs.readFileSync(new URL(platform==='darwin'?'../macos/cloudpc-connector.py':'./cloudpc-connector.py',import.meta.url),'utf8')};
}

export function sshExitCode(stderr) {
  if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr))return 'SSH_HOST_KEY';
  if(/Permission denied|Authentication failed|Too many authentication failures|incorrect passphrase/i.test(stderr))return 'SSH_AUTH';
  if(/Python 3.9|python3:.*not found|Traceback|ValueError:|PermissionError:/i.test(stderr))return 'SSH_SETUP';
  return 'SSH_DISCONNECTED';
}

export class SshPipe extends EventEmitter {
  constructor({ssh='ssh',login,env=process.env,payload,spawnProcess=spawn}) {
    super();this.readyState=1;this.bufferedAmount=0;
    const bootstrap=fs.readFileSync(new URL('./ssh-bootstrap.py',import.meta.url),'utf8');
    // No credentials or user paths enter the remote shell command.
    const command='python3 -I -B -u -c '+quote(bootstrap);
    this.child=spawnProcess(ssh,[...sshArguments(login,{background:true}),command],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stderr='';
    this.child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16384);});
    this.child.stdout.on('data',chunk=>this.emit('message',chunk,true));
    this.child.stdin.on('error',()=>{});
    this.child.on('error',()=>this.emit('error',Object.assign(Error('无法启动 SSH 客户端'),{code:'SSH_START'})));
    this.child.on('close',()=>{
      if(this.readyState===3)return;
      this.readyState=3;const code=sshExitCode(stderr);
      this.emit('error',Object.assign(Error(code==='SSH_AUTH'?'SSH 认证失败，请检查密码或密钥':code==='SSH_HOST_KEY'?'SSH 主机指纹校验失败，请核对服务器指纹':code==='SSH_SETUP'?'云端 MCP 配置失败，请检查 Python 3.9 和账户配置权限':'SSH 连接中断'),{code}));
      this.emit('close',1006,'ssh closed');
    });
    this.child.stdin.write(JSON.stringify(payload)+'\n');
  }
  send(text) {
    const message=JSON.parse(text);
    if(message.t==='kill'){this.close();return;}
    if(message.t!=='i'||typeof message.d!=='string'||this.readyState!==1)throw Error('SSH pipe unavailable');
    this.child.stdin.write(message.d);this.bufferedAmount=this.child.stdin.writableLength;
  }
  close(){if(this.readyState===3)return;this.readyState=3;this.child.stdin.end();this.child.kill();queueMicrotask(()=>this.emit('close',1000,'closed'));}
  terminate(){this.close();}
}

export async function startSshMcp({key,login,ssh,env,forward,catalog,signal,status=()=>{},transport, retryDelay, heartbeatMs=5000, silenceMs=45000}) {
  const recovery=new RequestRecovery({limit:16384});
  let active=null,attempt=0,closed=false;
  const close=()=>{
    if(closed)return;closed=true;
    if(active?.readyState===1)active.shutdown().catch(()=>active?.terminate());
    else active?.terminate();
  };
  signal.addEventListener('abort',close,{once:true});
  try {
    while(!signal.aborted&&!closed) {
      status('connecting','正在通过 SSH 配置 Claude Code 的本机工具');
      const pipe=transport ? transport() : new SshPipe({ssh,login,env,payload:bootstrapPayload(key,catalog)});
      const link=active=new TerminalLink(null,{transport:pipe,startupTimeout:180000,relayErrorCode:'SSH_SETUP'});
      const failure=await new Promise(resolve=>{
        let error,pending=0,lastPong=Date.now(),heartbeat;
        const finish=()=>{clearInterval(heartbeat);resolve(error);};
        link.on('error',e=>{error=e;});
        link.once('close',code=>{if(code===4002)error=Object.assign(Error('SSH connection replaced'),{code:'SSH_REPLACED'});finish();});
        link.once('open',()=>link.send(JSON.stringify({t:'hello',machine:key,name:os.hostname(),version:'ssh-1',recovery:{protocol:1,epoch:recovery.epoch}})));
        link.on('pong',()=>{lastPong=Date.now();});
        link.on('message',async data=>{
          let message;try{message=JSON.parse(data);}catch{return;}
          if(message.t==='welcome') {
            attempt=0;lastPong=Date.now();status('ready','本机 MCP 已就绪；进入终端后输入 claude 即可使用');
            heartbeat=setInterval(()=>{if(Date.now()-lastPong>silenceMs){link.terminate();return;}try{link.ping();}catch{link.terminate();}},heartbeatMs);
            return;
          }
          if(message.t!=='req'||typeof message.id!=='string')return;
          if(pending>=16){link.send(JSON.stringify({t:'res',id:message.id,error:'Too many requests'}));return;}
          pending++;
          try {
            const reply=message.recovery?.protocol===1
              ? {...await recovery.handle(message.recovery.requestId,message.msg,message.recovery.action,forward),id:message.id}
              : {t:'res',id:message.id,msg:await forward(message.msg)};
            if(link.readyState===1)link.send(JSON.stringify(reply));
          } catch {if(link.readyState===1)link.send(JSON.stringify({t:'res',id:message.id,error:'本机工具调用失败，请检查操作状态'}));}
          finally{pending--;}
        });
      });
      active=null;
      if(signal.aborted||closed)break;
      if(['SSH_AUTH','SSH_HOST_KEY','SSH_SETUP','SSH_START','SSH_REPLACED'].includes(failure?.code)) {
        status('failed',{SSH_AUTH:'SSH 认证失败，请检查密码或密钥',SSH_HOST_KEY:'SSH 主机指纹校验失败，请核对服务器指纹',SSH_SETUP:'云端 MCP 配置失败，请检查 Python 3.9 和账户配置权限',SSH_START:'无法启动 SSH 客户端',SSH_REPLACED:'云端 MCP 已被其他连接接管，已暂停自动重连'}[failure.code]);return;
      }
      const wait=retryDelay??[1000,3000,5000,10000,20000][Math.min(attempt++,4)];
      status('recovering','SSH 暂时中断，正在恢复；未确认的操作不会重复执行');
      await delay(wait,undefined,{signal}).catch(()=>{});
    }
  } finally {close();signal.removeEventListener('abort',close);}
}
