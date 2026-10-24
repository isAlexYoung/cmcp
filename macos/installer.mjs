import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LABEL,privateDir,safeFile,atomicWrite,runFile,launchPlist} from './platform.mjs';

function copyTree(from,to){
  const st=fs.lstatSync(from);if(st.isSymbolicLink())throw Error('安装源包含符号链接：'+from);
  if(st.isDirectory()){
    fs.mkdirSync(to,{mode:0o700});for(const name of fs.readdirSync(from)){if(name==='.bin')continue;copyTree(path.join(from,name),path.join(to,name));}
  }else if(st.isFile()){fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);fs.chmodSync(to,0o600);}else throw Error('安装源包含特殊文件');
}

// The injectable runner allows failure/rollback checks without a Mac launchd.
export async function installApp({kit,state,agents,node,uid,files,run=runFile}){
  privateDir(state);privateDir(agents);
  const plist=path.join(agents,LABEL+'.plist'),target=`gui/${uid}/${LABEL}`;
  const app=path.join(state,'app'),old=path.join(state,'app-old-'+randomUUID()),stage=path.join(state,'app-stage-'+randomUUID());
  safeFile(plist);const previous=fs.existsSync(plist)?fs.readFileSync(plist):null;
  if(fs.existsSync(app))privateDir(app);
  for(const log of ['launchd.log','launchd-error.log']){const file=path.join(state,log);safeFile(file);if(!fs.existsSync(file))atomicWrite(file,'');}
  let wasLoaded=false,stopped=false,moved=false,published=false,plistWritten=false,bootstrapAttempted=false;
  privateDir(stage);
  const loaded=async()=>{try{await run('/bin/launchctl',['print',target]);return true;}catch{return false;}};
  try{
    for(const file of files)copyTree(path.join(kit,file),path.join(stage,file));
    wasLoaded=await loaded();
    if(wasLoaded)await run('/bin/launchctl',['bootout',target]);
    stopped=true;
    if(fs.existsSync(app)){fs.renameSync(app,old);moved=true;}
    fs.renameSync(stage,app);published=true;
    atomicWrite(plist,launchPlist(node,app,state));plistWritten=true;
    // Do not accept a recent status left by the previous process as a new connection.
    atomicWrite(path.join(state,'status.json'),JSON.stringify({at:new Date().toISOString(),targets:{}}));
    await run('/bin/launchctl',['enable',target]);
    bootstrapAttempted=true;
    await run('/bin/launchctl',['bootstrap',`gui/${uid}`,plist]);
  }catch(error){
    if(stopped){
      try{
        if(bootstrapAttempted&&await loaded())await run('/bin/launchctl',['bootout',target]);
        if(published)fs.renameSync(app,stage);
        if(moved)fs.renameSync(old,app);
        if(plistWritten){if(previous===null)fs.unlinkSync(plist);else atomicWrite(plist,previous);}
        if(wasLoaded)await run('/bin/launchctl',['bootstrap',`gui/${uid}`,plist]);
      }catch{
        throw Error('安装失败且自动恢复未完成。请保留数据目录中的 app-old-* 文件夹，检查 launchd 日志后重新运行 Start。');
      }
    }
    throw error;
  }finally{
    if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});
  }
  if(fs.existsSync(old))fs.rmSync(old,{recursive:true,force:true});
}
