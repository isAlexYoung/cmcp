import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {KIT,STATE,LABEL,VERSION,privateDir,safeFile,atomicWrite,readConfig,normalizeUrl,keychain,prompt,runFile,proxyFor,launchPlist} from './platform.mjs';
import {Cloud} from './cloud-api.mjs';
import {installApp as install} from './installer.mjs';
const ACTION=process.argv[2]??'start';
const INSTALL_FILES=['platform.mjs','installer.mjs','schema.mjs','binary-tools.mjs','mac-tools.mjs','process-worker.mjs','dispatcher.mjs','service.mjs','link-client.mjs','terminal-link.mjs','tool-schemas.mjs','cloudpc-relay.py','cloudpc-connector.py','keychain.jxa','keyboard.jxa','ui.jxa','cloud-api.mjs','cli.mjs','package.json','package-lock.json','node_modules'];
const agents=path.join(os.homedir(),'Library','LaunchAgents'),plist=path.join(agents,LABEL+'.plist');
const serviceTarget=`gui/${process.getuid?.()}/${LABEL}`;
async function loaded(){try{await runFile('/bin/launchctl',['print',serviceTarget]);return true;}catch{return false;}}
async function stop(){if(await loaded())await runFile('/bin/launchctl',['bootout',serviceTarget]);}
async function installApp(){
  await install({kit:KIT,state:STATE,agents,node:process.execPath,uid:process.getuid(),files:INSTALL_FILES});
  console.log('已安装 macOS 当前用户登录启动服务。');
}
async function addTarget(){
  const config=readConfig();
  const value=await prompt('添加云电脑','请输入 HTTPS 云电脑首页地址');if(value===null)return false;
  const url=normalizeUrl(value),password=await prompt('云电脑密码',`请输入 ${url} 的访问密码`,true);if(password===null)return false;
  if(!password||password.length>4096)throw Error('密码为空或过长');
  const cloud=await Cloud.connect(url,password,await proxyFor());cloud.close();
  const previous=config.targets.find(t=>t.url===url),id=randomUUID();
  if(!previous&&config.targets.length>=8)throw Error('最多保存 8 台云电脑，请先删除不用的连接');
  await keychain('set',id,password);
  const target={id,url,changed:randomUUID()};
  if(previous)config.targets[config.targets.indexOf(previous)]=target;else config.targets.push(target);
  // Publish the new credential reference only after its Keychain write succeeds.
  try{atomicWrite(path.join(STATE,'targets.json'),JSON.stringify(config,null,2));}
  catch(e){await keychain('delete',id).catch(()=>{});throw e;}
  if(previous)await keychain('delete',previous.id).catch(()=>console.log('旧凭据未能删除，可在钥匙串访问中清理账号：'+previous.id));
  console.log('已验证登录，密码保存到 macOS 钥匙串。');return true;
}
async function waitConnection(id){
  for(let i=0;i<90;i++){
    try{const board=JSON.parse(fs.readFileSync(path.join(STATE,'status.json'),'utf8'));const s=board.targets[id];
      if(Date.now()-Date.parse(board.at)<15000){if(s?.state==='connected')return;if(['password','locked','expired','notset','url','error','replaced'].includes(s?.state))throw Error(s.message);}}
    catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    await delay(1000);
  }throw Error('90 秒内未连接。请双击 Status-Claude-MCP.command 查看状态');
}
async function configureCloud(){
  for(const target of readConfig().targets){
    console.log('正在等待连接：'+target.url);await waitConnection(target.id);
    const cloud=await Cloud.connect(target.url,await keychain('get',target.id),await proxyFor());
    try{const changed=await cloud.install();console.log(target.url+'：'+(changed?'云端已更新，请重启云端 Claude。':'配置已是最新。'));}finally{cloud.close();}
  }
}
async function status(){
  console.log('Claude MCP Mac '+VERSION);console.log('登录服务：'+(await loaded()?'运行中':'未运行'));
  let board;try{board=JSON.parse(fs.readFileSync(path.join(STATE,'status.json'),'utf8'));}catch{}
  const fresh=board&&Date.now()-Date.parse(board.at)<15000;
  for(const t of readConfig().targets){const s=fresh?board.targets[t.id]:null;console.log(t.url+'：'+(s?.message??'暂无有效状态'));}
  console.log('本地数据目录：'+STATE);
}
async function remove(){
  const config=readConfig();if(!config.targets.length)return;
  config.targets.forEach((t,i)=>console.log(`${i+1}. ${t.url}`));
  const raw=await prompt('删除连接','输入要删除的连接序号（密码也会从钥匙串删除）');if(raw===null)return;
  const index=Number(raw.trim())-1;if(!Number.isInteger(index)||index<0||index>=config.targets.length)throw Error('序号无效');
  const [target]=config.targets.splice(index,1);await stop();
  atomicWrite(path.join(STATE,'targets.json'),JSON.stringify(config,null,2));await keychain('delete',target.id);
  if(config.targets.length)await installApp();console.log('已删除本地连接。云端已有的 MCP 配置保留，可按说明移除。');
}
async function main(){
  if(process.platform!=='darwin')throw Error('请在 Mac 上使用 .command 启动文件。Windows 无法运行 macOS 服务。');
  if(process.getuid()===0)throw Error('请使用普通 Mac 用户运行，不要 sudo');
  process.umask(0o077);privateDir(STATE);
  if(ACTION==='status')return status();
  if(ACTION==='stop'){await stop();console.log('后台服务已停止，下次登录会重新启动；永久停用请使用 Uninstall。');return;}
  if(ACTION==='remove')return remove();
  if(ACTION==='uninstall'){
    await stop();safeFile(plist);if(fs.existsSync(plist))fs.unlinkSync(plist);
    for(const t of readConfig().targets)await keychain('delete',t.id);
    atomicWrite(path.join(STATE,'targets.json'),JSON.stringify({targets:[],roots:[os.homedir()]},null,2));
    console.log('已卸载登录服务并删除保存的密码。本地程序和日志保留；云端配置的移除方法见 README。');return;
  }
  if(!['start','add','repair'].includes(ACTION))throw Error('未知操作');
  if(ACTION==='add'||!readConfig().targets.length){if(!await addTarget())return;}
  await installApp();await configureCloud();await status();
}
let commandLock;
try{
  if(process.platform==='darwin'&&ACTION!=='status'){
    privateDir(STATE);commandLock=path.join(STATE,'settings.lock');
    try{fs.mkdirSync(commandLock,{mode:0o700});}catch(e){commandLock=undefined;if(e.code==='EEXIST')throw Error('已有设置窗口运行。请先关闭它；若上次异常退出，请确认没有设置程序运行后删除数据目录中的 settings.lock 空文件夹。');throw e;}
  }
  await main();
}catch(e){console.error('操作失败：'+e.message);process.exitCode=1;}
finally{if(commandLock)try{fs.rmdirSync(commandLock);}catch{}}
