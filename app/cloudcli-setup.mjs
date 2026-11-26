// "初始化／修复 ClaudeWeb 连接" for standalone ClaudeWeb or a CloudCLI installed without WebDesktop
// (Ubuntu/Debian only). Over the device's saved SSH it checks the system, finds ClaudeWeb (the
// claudeweb service) or CloudCLI, its account and port, the
// Claude CLI and the CMCP MCP entry, then lists what it would change and asks once. It can install
// the missing Claude CLI and save the connection details for the next connection. It never touches
// CloudCLI itself, its service, nginx, Caddy or firewalls. A sudo password is used for this run
// only and travels through stdin, never through arguments or the environment.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sshArguments,sshExitCode} from './ssh-mcp.mjs';
import {readSshLogin} from './ssh-terminal.mjs';
import {recordCloudcliKind,SELF_HOSTED,CLAUDEWEB} from './cloudcli.mjs';
import {connectorPolicy} from './connection-policy.mjs';
import {spawnSshWithRecovery,HOST_KEY_RECOVERY_ERROR} from './ssh-host-key.mjs';

const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
const script=()=>fs.readFileSync(new URL('./cloudcli-setup.py',import.meta.url),'utf8');
const wrapper=`command -v python3 >/dev/null 2>&1 || { printf '%s\\n' '{"ok":false,"code":"PYTHON"}'; exit 0; }; exec python3 -I -B -c "$1"`;
export const setupCommand=source=>'sh -c '+quote(wrapper)+' sh '+quote(source);

const sshFailure={SSH_AUTH:'SSH 认证失败，请检查密码或密钥。',SSH_HOST_KEY:HOST_KEY_RECOVERY_ERROR,SSH_START:'无法启动 SSH 客户端，请检查系统的 OpenSSH 安装。'};
// One SSH call: a JSON line in, a JSON line out. Nothing secret is on the command line.
export function runRemote(login,request,{ssh='ssh',env=process.env,spawnProcess=spawn,timeout=120000,knownHostsFile}={}){
  return new Promise((resolve,reject)=>{
    let child;try{child=spawnSshWithRecovery(ssh,[...sshArguments(login,{background:true}),setupCommand(script())],{env,windowsHide:true,stdio:['pipe','pipe','pipe']},{login,spawnProcess,knownHostsFile,input:JSON.stringify(request)+'\n',endInput:true});}catch{reject(Object.assign(Error(sshFailure.SSH_START),{code:'SSH_START'}));return;}
    let out='',err='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);try{child.kill();}catch{}error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(Object.assign(Error('VPS 在规定时间内没有回应，未确认结果。'),{code:'TIMEOUT'})),timeout);
    child.stdout.on('data',c=>{out+=c;if(out.length>1024*1024)finish(Error('VPS 回应过大'));});
    child.stderr.on('data',c=>{err=(err+c).slice(-16384);});
    child.stdin.on('error',()=>{});
    child.on('error',()=>finish(Object.assign(Error(sshFailure.SSH_START),{code:'SSH_START'})));
    child.on('close',()=>{
      const line=out.split('\n').find(l=>l.trim().startsWith('{'));
      if(line){try{finish(null,JSON.parse(line));return;}catch{}}
      const code=sshExitCode(err);finish(Object.assign(Error(sshFailure[code]||'无法通过 SSH 完成检查，请确认 SSH 登录可用。'),{code}));
    });
  });
}

const privilegeText={root:'root',['sudo-nopass']:'sudo（无需密码）',['sudo-password']:'sudo（需要密码）',none:'无 root 或 sudo 权限'};
// What the VPS reported, turned into what would change. Nothing here touches the VPS.
export function planSetup(report,{login,connector,hasDirectUrl=false,directUrl=''}){
  const stop=message=>({blocker:message,summary:[],steps:[]});
  if(report?.code==='PYTHON')return stop('VPS 上没有 python3。本机工具的 SSH 通道需要 Python 3.9 或更新版本，请先安装 python3。未做任何修改。');
  if(!report?.ok||!report.os)return stop('无法读取 VPS 的检查结果，未做任何修改。');
  if(!report.os.supported)return stop(`只支持 Ubuntu 和 Debian；这台 VPS 是 ${report.os.pretty||report.os.id||'未知系统'}。未做任何修改。`);
  const [major,minor]=String(report.python||'0.0').split('.').map(Number);
  if(major<3||major===3&&minor<9)return stop(`VPS 上的 Python 是 ${report.python}，本机工具的 SSH 通道需要 3.9 或更新版本。未做任何修改。`);
  if(report.webdesktop)return stop('这台 VPS 运行 WebDesktop，它的 ClaudeWeb 由 WebDesktop 连接，不需要初始化。未做任何修改。');
  const chosen=report.chosen;
  if(!chosen)return stop('没有在这台 VPS 上找到 ClaudeWeb 独立版或 CloudCLI（siteboon/claudecodeui）的服务或进程。请先安装并启动它。未做任何修改。');
  const standalone=chosen.claudeweb===true,product=standalone?'ClaudeWeb 独立版':'CloudCLI';
  if(!report.account)return stop(`找不到 ClaudeWeb 的运行用户 ${chosen.user}。未做任何修改。`);
  const me=report.me.user,user=report.account.user,port=chosen.port;
  if(user!==me&&report.me.uid!==0)return stop(`ClaudeWeb 以用户 ${user} 运行，而 SSH 登录用户是 ${me}。本机工具通道必须以 ${user} 的身份写入它的 Claude 配置：请把这台设备的 SSH 用户改为 ${user} 或 root 后重试。未做任何修改。`);
  const summary=[`系统：${report.os.pretty}`,
    `${product}：${chosen.unit?'systemd 服务 '+chosen.unit:'进程 '+chosen.pid}${chosen.running?'':'（当前未运行）'}，用户 ${user}，端口 ${port}${chosen.portKnown?'':'（未读到，按默认 3001）'}`,
    ...(report.instances?.length>1?[`共找到 ${report.instances.length} 个 ClaudeWeb，使用上面这一个。`]:[]),
    `Claude CLI：${report.claude?.found?(report.claude.version||'已安装'):'未安装'}`,
    `CMCP 的 MCP 条目：${report.mcp?.present?'已存在':'缺少'}`,
    `SSH 用户 ${me} 的权限：${privilegeText[report.privilege]||report.privilege}`,
    ...(standalone?['登录密码：在 VPS 上以 root 运行 claudeweb password 查看。在 CMCP 编辑页填写 ClaudeWeb 密码并打开自动登录后，打开网页时会自动登录。']:[])];
  if(report.mcp?.invalid)return {...stop(`${user} 的 ~/.claude.json 不是有效的 JSON，CMCP 不会改写它。请先修复这个文件。未做任何修改。`),summary};
  if(report.mcp&&!report.mcp.readable)return {...stop(`无法读取 ${user} 的 ~/.claude.json。未做任何修改。`),summary};
  const steps=[],runAs=report.me.uid===0&&user!=='root'?user:'';let install=null,needsPassword=false;
  if(runAs!==(login.cloudcliUser||''))steps.push(runAs?`SSH 后台通道以 ${user}（ClaudeWeb 的运行用户）的身份运行`:`SSH 后台通道以 SSH 登录用户 ${me} 的身份运行`);
  // Standalone ClaudeWeb installs the official Claude CLI itself; CMCP never installs a second one.
  if(!report.claude?.found&&standalone)return {...stop('没有找到 ClaudeWeb 独立版的 Claude CLI（/home/claudeweb/.local/bin/claude）。请在 VPS 上以 root 运行 claudeweb doctor 检查后重试。未做任何修改。'),summary};
  if(!report.claude?.found){
    if(!report.npm)return {...stop('没有找到 npm，无法安装 Claude CLI。CloudCLI 依赖 Node.js；请确认 npm 可用后重试。未做任何修改。'),summary};
    const mode=report.npm.userWritable?'user':'root';
    if(mode==='root'&&report.privilege==='none')return {...stop(`安装 Claude CLI 需要 root 或 sudo 权限，而 ${me} 两者都没有。请改用 root 登录，或请管理员为 ${user} 安装 Claude CLI。未做任何修改。`),summary};
    install={account:user,mode,node:chosen.node||null};needsPassword=mode==='root'&&report.privilege==='sudo-password';
    steps.push(`为 ${user} 安装 Claude CLI（npm install -g @anthropic-ai/claude-code${mode==='root'?'，以 root 身份':''}）`);
  }
  if(!report.mcp?.present)steps.push(`下次连接时在 ${user} 的 ~/.claude.json 中注册 CMCP 的本机连接器（原文件先备份）`);
  const save={cloudcliUser:runAs,cloudcliPort:port,cloudcliTunnel:hasDirectUrl?login.cloudcliTunnel===true:true,sshAutoStart:false};
  if(port===(login.webPort??3000)){if(login.webTunnel)return {...stop(`ClaudeWeb 的端口 ${port} 与这台设备的 WebDesktop 隧道端口相同，请先在编辑页调整。未做任何修改。`),summary};save.webPort=port===3000?3002:3000;}
  if(port!==(login.cloudcliPort??3001))steps.push(`记录 ClaudeWeb 端口 ${port}`);
  if(!hasDirectUrl&&login.cloudcliTunnel!==true)steps.push(`启用 ClaudeWeb 的 SSH 隧道（VPS 本机端口 ${port}）`);
  return {summary,steps,save,install,needsPassword,account:user,port,url:hasDirectUrl?directUrl:'',kind:standalone?CLAUDEWEB:SELF_HOSTED,
    clean:!install&&report.mcp?.present===true};
}

const installFailure={SUDO:'sudo 密码不正确，或这个用户不能使用 sudo。未完成安装。',NPM:'没有找到 npm，未完成安装。',NPM_FAILED:'npm 安装 Claude CLI 失败，请在 VPS 上查看 npm 的输出。',TIMEOUT:'安装超过 10 分钟仍未完成，未确认结果。',ACCOUNT:'找不到 ClaudeWeb 的运行用户。',START:'无法在 VPS 上启动安装命令。'};
export async function runSetup({directory,id,login=readSshLogin(directory,id),ssh='ssh',env=process.env,directUrl='',confirm,save=async()=>{},progress=()=>{},remote=runRemote}){
  const connector=connectorPolicy(directory,id,'ssh',false).name,options={ssh,env};
  progress('正在通过 SSH 检查 VPS（只读）…');
  const plan=planSetup(await remote(login,{action:'inspect',connector,port:login.cloudcliPort??null},options),{login,connector,hasDirectUrl:!!directUrl,directUrl});
  if(plan.blocker)return {ok:false,message:plan.blocker,summary:plan.summary};
  const answer=await confirm(plan);
  if(!answer?.ok)return {ok:false,cancelled:true,message:'已取消，未做任何修改。',summary:plan.summary};
  let password=answer.password;
  try{
    await save(plan.save);
    try{recordCloudcliKind(directory,id,plan.kind||SELF_HOSTED);}catch{}
    if(plan.install){
      progress('正在为 '+plan.account+' 安装 Claude CLI，可能需要几分钟…');
      const result=await remote(login,{action:'install',connector,...plan.install,...plan.needsPassword?{password:password||''}:{}},{...options,timeout:700000});
      if(!result?.ok)return {ok:false,message:installFailure[result?.code]||'Claude CLI 未能安装。',summary:plan.summary};
    }
  }finally{password=undefined;answer.password=undefined;}
  progress('正在确认 VPS 上的结果…');
  const after=await remote(login,{action:'inspect',connector,port:plan.port},options);
  const missing=[!after.claude?.found&&'Claude CLI'].filter(Boolean);
  if(missing.length)return {ok:false,message:'仍缺少：'+missing.join('、')+'。可稍后再运行一次初始化／修复。',summary:plan.summary};
  return {ok:true,message:`已保存 ${plan.account} 的连接配置。连接设备后，CMCP 会按所选方式启动本机工具。请在 ClaudeWeb 中开始新会话核对。`,url:plan.url,summary:plan.summary};
}

// Windows: the manager window runs this and answers on stdin. Each line out is one JSON event:
// plan, progress, done. The window saves the device before it answers a plan with ok.
async function main(){
  const args=process.argv.slice(2),get=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  const directory=path.resolve(get('--state')||''),id=get('--id'),owner=Number(get('--owner'));
  if(!get('--state')||!id||!Number.isInteger(owner))throw Error('Missing setup parameters');
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  const lines=readline.createInterface({input:process.stdin});const answers=lines[Symbol.asyncIterator]();
  const result=await runSetup({directory,id,owner,ssh:get('--ssh')||'ssh',directUrl:get('--url')||'',progress:message=>emit({t:'progress',message}),
    confirm:async plan=>{emit({t:'plan',plan:{summary:plan.summary,steps:plan.steps,save:plan.save,needsPassword:plan.needsPassword,account:plan.account,port:plan.port}});
      const next=await answers.next();if(next.done)return {ok:false};try{const value=JSON.parse(next.value);return {ok:value.ok===true,password:typeof value.password==='string'?value.password:undefined};}catch{return {ok:false};}}});
  lines.close();emit({t:'done',ok:result.ok,cancelled:result.cancelled===true,message:result.message,summary:result.summary||[],url:result.url||''});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{process.stdout.write(JSON.stringify({t:'done',ok:false,message:error.message||'初始化未完成'})+'\n');process.exitCode=1;});
