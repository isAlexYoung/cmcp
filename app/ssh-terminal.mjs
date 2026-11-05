// Terminal preflight starts/reuses one background SSH MCP worker per device.
// Only the already-configured local executors run tools. No inbound TCP port.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startSshMcp,sshArguments} from './ssh-mcp.mjs';
import {createSshDispatcher} from './ssh-local-tools.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function safeFile(file) {try{const s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1||process.getuid&&s.uid!==process.getuid())throw Error('Unsafe SSH state file');}catch(e){if(e.code!=='ENOENT')throw e;}}
export function privateDirectory(directory) {
  // macOS itself makes /var and /tmp links, and the temporary folder lives under /var. Any other link is refused.
  const systemLink=p=>process.platform==='darwin'&&(p==='/var'||p==='/tmp');
  for(let p=directory;p!==path.dirname(p);p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink()&&!systemLink(p))throw Error('Unsafe SSH state directory');}catch(e){if(e.code!=='ENOENT')throw e;}}
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const s=fs.statSync(directory);if(!s.isDirectory()||process.getuid&&s.uid!==process.getuid())throw Error('Unsafe SSH state directory');
  if(process.platform!=='win32')fs.chmodSync(directory,0o700);
  return directory;
}
export function workerPaths(directory,id) {
  if(typeof id!=='string'||!id||id.length>512||/[\x00-\x1f]/.test(id))throw Error('Invalid device');
  const key=hash(path.resolve(directory)+'\0'+id),folder=privateDirectory(path.join(directory,'ssh-mcp'));
  const socketDirectory=process.platform==='win32'?null:privateDirectory(path.join(os.tmpdir(),'cmcp-ssh-'+(process.getuid?.()??'user')+'-'+key.slice(0,20)));
  return {key,endpoint:process.platform==='win32'?'\\\\.\\pipe\\cmcp-ssh-'+key:path.join(socketDirectory,'control.sock'),file:path.join(folder,key+'.json')};
}
export function readSshLogin(directory,id) {
  const file=path.join(directory,'ssh-logins.json');safeFile(file);
  const data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const login=data.logins?.find(item=>(item.id??item.name)===id);
  if(!login)throw Error('没有找到这台设备的 SSH 配置');
  sshArguments(login);return login;
}
export const profileRevision=login=>hash(JSON.stringify([login.host,login.port,login.username,login.method,login.keyPath,login.secret,login.credentialId]));
function writeState(file,state) {
  safeFile(file);const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{
    fs.writeFileSync(temporary,JSON.stringify(state),{flag:'wx',mode:0o600});
    try{fs.renameSync(temporary,file);}catch(error){
      // A Windows scanner can briefly deny replacement. Keep the last complete
      // record; the next heartbeat publishes the current state again.
      if(!['EPERM','EACCES'].includes(error.code)||!fs.existsSync(file))throw error;
    }
  }finally{try{fs.unlinkSync(temporary);}catch{}}
}
export function queryWorker(paths,action='status') {
  return new Promise((resolve,reject)=>{
    let record;try{safeFile(paths.file);record=JSON.parse(fs.readFileSync(paths.file,'utf8'));}catch(error){reject(error);return;}
    if(typeof record.token!=='string'||!/^[a-f0-9]{64}$/.test(record.token)){reject(Error('Invalid SSH worker'));return;}
    const socket=net.connect(paths.endpoint),chunks=[];let size=0;
    const finish=(error,value)=>{socket.destroy();error?reject(error):resolve(value);};
    socket.setTimeout(2000,()=>finish(Error('SSH worker did not respond')));
    socket.on('error',error=>finish(error));
    socket.on('connect',()=>socket.write(JSON.stringify({token:record.token,action})+'\n'));
    socket.on('data',chunk=>{size+=chunk.length;if(size>8192)return finish(Error('Invalid worker response'));chunks.push(chunk);if(chunk.includes(10)){try{finish(null,JSON.parse(Buffer.concat(chunks)));}catch(error){finish(error);}}});
    socket.on('end',()=>finish(Error('SSH worker closed')));
  });
}

export async function runWorker({directory,id,owner,ssh='ssh',createDispatcher=createSshDispatcher,connect=startSshMcp}) {
  const login=readSshLogin(directory,id),revision=profileRevision(login),paths=workerPaths(directory,id);
  if(!Number.isInteger(owner)||owner<=0||!alive(owner))throw Error('CMCP 主界面已退出');
  const controller=new AbortController();let dispatcher,watch,task;
  const state={pid:process.pid,owner,revision,token:randomBytes(32).toString('hex'),state:'connecting',message:'正在启动 SSH MCP'};
  const persist=()=>{state.at=Date.now();writeState(paths.file,state);};
  const status=(phase,message)=>{state.state=phase;state.message=message;persist();};
  const stop=()=>controller.abort();
  const server=net.createServer(socket=>{
    let data='';socket.setTimeout(2000,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      data+=chunk;if(data.length>2048){socket.destroy();return;}if(!data.includes('\n'))return;
      let value;try{value=JSON.parse(data);}catch{socket.destroy();return;}
      const token=Buffer.from(String(value.token||'')),expected=Buffer.from(state.token);
      if(token.length!==expected.length||!timingSafeEqual(token,expected)){socket.destroy();return;}
      if(value.action==='stop')stop();else if(value.action!=='status'){socket.destroy();return;}
      const {token:_,...view}=state;socket.end(JSON.stringify(view)+'\n');
    });
  });
  try {
    // A stale Unix socket is removed only after probing and a startup grace period.
    if(process.platform!=='win32'&&fs.existsSync(paths.endpoint)){
      try{await queryWorker(paths);return;}catch{}
      if(Date.now()-fs.statSync(paths.endpoint).mtimeMs<5000)return;
      const entry=fs.lstatSync(paths.endpoint);if(!entry.isSocket()||entry.uid!==process.getuid())throw Error('Unsafe SSH worker socket');
      fs.unlinkSync(paths.endpoint);
    }
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(paths.endpoint,resolve);});
    if(process.platform!=='win32')fs.chmodSync(paths.endpoint,0o600);
    persist();
    watch=setInterval(()=>{
      try{if(!alive(owner)||profileRevision(readSshLogin(directory,id))!==revision){stop();return;}persist();}catch{stop();}
    },1000);
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    dispatcher=await createDispatcher(directory);
    if(controller.signal.aborted)return;
    const initialized=await dispatcher.forward({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25'}});
    const catalog={...(await dispatcher.forward({jsonrpc:'2.0',id:1,method:'tools/list'})).result,
      instructions:initialized.result?.instructions};
    const env={...process.env,CMCP_STATE_DIR:directory};
    task=connect({key:paths.key,login,ssh,env,forward:dispatcher.forward,catalog,signal:controller.signal,status});
    await task;
    // Keep a fixed failure visible to terminal launchers; no automatic auth retry.
    if(state.state==='failed'&&!controller.signal.aborted)await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
  } catch(error){
    if(error.code==='EADDRINUSE')return;
    if(server.listening){status('failed','SSH MCP 启动失败，请检查本机工具和连接配置');await delay(3000);}
    else throw error;
  } finally {
    stop();clearInterval(watch);await task?.catch(()=>{});await dispatcher?.close().catch(()=>{});
    if(server.listening){await new Promise(resolve=>server.close(resolve));try{const record=JSON.parse(fs.readFileSync(paths.file,'utf8'));if(record.token===state.token)fs.unlinkSync(paths.file);}catch{}}
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
}

export async function ensureSshWorker({directory,id,owner,ssh='ssh',timeout=180000,launch=spawn,progress=message=>process.stdout.write(message+'\n')}) {
  const paths=workerPaths(directory,id),revision=profileRevision(readSshLogin(directory,id));
  let state;try{state=await queryWorker(paths);}catch{}
  if(state&&(state.revision!==revision||state.owner!==owner||state.state==='failed')){
    await queryWorker(paths,'stop');for(let i=0;i<100;i++){await delay(100);try{await queryWorker(paths);}catch{state=null;break;}}
    if(state)throw Error('上一次 SSH 通道仍在停止，请稍后重试');
  }
  if(!state){
    const child=launch(process.execPath,[fileURLToPath(import.meta.url),'--worker','--state',directory,'--id',id,'--owner',String(owner),'--ssh',ssh],{env:{...process.env,CMCP_STATE_DIR:directory},detached:true,windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{});child.unref();
  }
  const start=Date.now();let previous='';
  while(Date.now()-start<timeout) {
    if(!alive(owner))throw Error('CMCP 主界面已退出');
    try{state=await queryWorker(paths);}catch{state=null;}
    if(state?.revision===revision&&state.owner===owner){
      if(state.state==='ready')return state;
      if(state.state==='failed')throw Error(state.message);
      if(state.message!==previous){progress(state.message);previous=state.message;}
    }
    await delay(200);
  }
  throw Error('SSH MCP 准备超时；通道会继续恢复，请查看连接或重新打开终端');
}

// Empty while nothing runs. The worker rewrites its record every second.
export function sshWorkerState(directory,id,now=Date.now()) {
  try{
    const file=path.join(directory,'ssh-mcp',hash(path.resolve(directory)+'\0'+id)+'.json');
    safeFile(file);const record=JSON.parse(fs.readFileSync(file,'utf8'));
    return now-record.at>10000||!alive(record.pid)?'':String(record.state||'');
  }catch{return '';}
}
// Only this device's background channel; a terminal window the user opened stays theirs.
export async function stopSshWorker(directory,id) {
  const paths=workerPaths(directory,id);
  await queryWorker(paths,'stop');
  for(let i=0;i<100;i++){await delay(100);try{await queryWorker(paths);}catch{return;}}
  throw Error('SSH MCP 后台仍在停止，请稍后重试');
}

export async function stopSshWorkers(directory) {
  const folder=path.join(directory,'ssh-mcp');
  if(!fs.existsSync(folder))return;
  const pending=[];
  for(const name of fs.readdirSync(folder)) {
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const key=name.slice(0,-5),file=path.join(folder,name);
    const endpoint=process.platform==='win32'?'\\\\.\\pipe\\cmcp-ssh-'+key:path.join(os.tmpdir(),'cmcp-ssh-'+(process.getuid?.()??'user')+'-'+key.slice(0,20),'control.sock');
    pending.push((async()=>{
      const paths={file,endpoint};
      try{await queryWorker(paths,'stop');}catch{return;}
      for(let i=0;i<100;i++){
        await delay(100);try{await queryWorker(paths);}catch{return;}
      }
      throw Error('SSH MCP 后台仍在停止，请稍后重试');
    })());
  }
  await Promise.all(pending);
}

async function main() {
  const args=process.argv.slice(2),get=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  if(args.includes('--stop-all')){if(!get('--state'))throw Error('Missing SSH state directory');await stopSshWorkers(path.resolve(get('--state')));return;}
  const options={directory:path.resolve(get('--state')||''),id:get('--id'),owner:Number(get('--owner')),ssh:get('--ssh')||'ssh'};
  if(!args.includes('--state')||!args.includes('--id')||!args.includes('--owner'))throw Error('Missing SSH launch parameters');
  if(args.includes('--worker'))await runWorker(options);
  else{await ensureSshWorker(options);process.stdout.write('本机 MCP 已就绪。进入 VPS 后输入 claude；在 /mcp 中可查看本机工具。\n');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{process.stderr.write('CMCP: '+error.message+'\n');process.exitCode=1;});
