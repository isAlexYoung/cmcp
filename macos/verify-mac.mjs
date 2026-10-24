import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {KIT,STATE,privateDir,atomicWrite,keychain,runFile,launchPlist} from './platform.mjs';
if(process.platform!=='darwin')throw Error('请在 Mac 上运行此检查');
process.umask(0o077);privateDir(STATE);
const id=randomUUID(),secret='测试"\n'+randomBytes(32).toString('base64');
const temp=fs.mkdtempSync(path.join(STATE,'self-check-'));
let written=false;
try{
  console.log('1/4 检查本机运行环境：'+os.arch()+' / Node '+process.version);
  await keychain('set',id,secret);written=true;
  if(await keychain('get',id)!==secret)throw Error('钥匙串读回不一致');
  await keychain('delete',id);written=false;console.log('2/4 钥匙串保存、读取、删除通过。');
  const plist=path.join(temp,'check.plist');atomicWrite(plist,launchPlist(process.execPath,KIT,STATE));
  await runFile('/usr/bin/plutil',['-lint',plist]);console.log('3/4 launchd plist 格式检查通过。');
  const tests=fs.readdirSync(path.join(KIT,'tests')).filter(n=>n.endsWith('.test.mjs')).map(n=>path.join(KIT,'tests',n));
  console.log(await runFile(process.execPath,['--test',...tests],{timeout:120000,maxBuffer:4*1024*1024}));
  console.log('4/4 本地自动化测试通过。此检查未建立云端连接。');
  console.log('仍需通过 Start 实际验证登录启动，以及系统设置中的屏幕录制和辅助功能授权。');
}catch(e){console.error('Mac 检查失败：'+e.message);process.exitCode=1;}
finally{if(written)await keychain('delete',id).catch(()=>console.error('请在钥匙串访问中删除测试条目，账号：'+id));fs.rmSync(temp,{recursive:true,force:true});}
