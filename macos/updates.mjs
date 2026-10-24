import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import https from 'node:https';
import {agentFor} from '../app/link-client.mjs';
import {privateDir} from './platform.mjs';

const repository='https://github.com/isAlexYoung/cmcp';
const hosts=new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const version=value=>{if(typeof value!=='string'||!/^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value))throw Error('Invalid stable version');return value.replace(/^v/,'').split('.').map(Number);};
export function selectRelease(release,current,arch){
  if(!['arm64','x64'].includes(arch)||release.draft!==false||release.prerelease!==false)throw Error('Invalid release');
  const next=version(release.tag_name),old=version(current);let comparison=0;for(let i=0;i<3&&!comparison;i++)comparison=next[i]-old[i];if(comparison<=0)return null;
  const number=next.join('.'),name=`CMCP-${number}-macos-${arch}.zip`;
  const pick=n=>{const matches=release.assets.filter(a=>a.name===n);if(matches.length!==1)throw Error('没有适用的 Mac 更新包');const asset=matches[0];if(asset.browser_download_url!==`${repository}/releases/download/${release.tag_name}/${n}`)throw Error('Untrusted asset URL');return asset;};
  const zip=pick(name),checksum=pick(name+'.sha256');
  if(!Number.isSafeInteger(zip.size)||zip.size<1||zip.size>268435456||checksum.size<1||checksum.size>1024)throw Error('Invalid asset size');
  return {version:number,name,zip,checksum};
}
export function receive(url,{proxy='',limit=2*1024*1024}={},redirects=0){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!hosts.has(parsed.hostname)||redirects>5)throw Error('Untrusted download URL');
  const agent=agentFor(url,proxy);
  return new Promise((resolve,reject)=>{
    const req=https.get(parsed,{agent,rejectUnauthorized:true,headers:{'User-Agent':'CMCP-mac-updater','Cache-Control':'no-cache'}},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();return resolve(receive(new URL(res.headers.location,parsed).href,{proxy,limit},redirects+1));}
      if(res.statusCode!==200){res.resume();return reject(Error('Update HTTP '+res.statusCode));}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>limit)req.destroy(Error('Download exceeds limit'));else chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
    });
    const deadline=setTimeout(()=>req.destroy(Error('Update deadline')),90000);req.once('close',()=>clearTimeout(deadline));
    req.on('error',reject);req.setTimeout(30000,()=>req.destroy(Error('Update timeout')));
  }).finally(()=>agent?.destroy());
}
export async function checkRelease(current,arch,proxy='',fetch=receive){return selectRelease(JSON.parse((await fetch('https://api.github.com/repos/isAlexYoung/cmcp/releases/latest',{proxy})).toString('utf8')),current,arch);}
export async function downloadUpdate({current,arch,proxy,directory,fetch=receive}){
  const release=await checkRelease(current,arch,proxy,fetch);if(!release)throw Error('已是最新版');
  const sum=(await fetch(release.checksum.browser_download_url,{proxy,limit:1024})).toString('utf8').trim();
  const match=/^([a-f0-9]{64})\s+\*?([^\r\n]+)$/.exec(sum);if(!match||match[2]!==release.name)throw Error('更新校验文件无效');
  const bytes=await fetch(release.zip.browser_download_url,{proxy,limit:268435456});
  const digest=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==release.zip.size||digest!==match[1]||(release.zip.digest&&release.zip.digest!=='sha256:'+digest))throw Error('更新包校验失败');
  const folder=path.join(privateDir(directory),'update-'+randomUUID());fs.mkdirSync(folder,{mode:0o700});
  fs.writeFileSync(path.join(folder,release.name),bytes,{flag:'wx',mode:0o600});
  return {folder,zip:path.join(folder,release.name),version:release.version,sha256:digest};
}
