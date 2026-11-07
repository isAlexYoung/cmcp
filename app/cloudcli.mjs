import fs from 'node:fs';
import path from 'node:path';
import {requestBuffered} from './desktop-auth.mjs';

export const cloudcliName=id=>'cloudcli:'+id;
export function cloudcliOrigin(value){
  const url=new URL(value);
  if(!(url.protocol==='https:'&&!url.port||url.protocol==='http:'&&url.hostname==='127.0.0.1')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('请输入完整的 CloudCLI HTTPS 地址，不含路径或登录信息。');
  return url.origin;
}
export async function discoverCloudcli(url,agent,signal){
  const origin=cloudcliOrigin(url),r=await requestBuffered(new URL('/api/auth/cmcp',origin),{agent,signal,timeout:10000,limit:16384});
  let data;try{data=JSON.parse(r.body);}catch{}
  if(r.status!==200||data?.protocol!=='cmcp-cloudcli'||data.version!==1)throw Object.assign(Error('CloudCLI 尚未提供 CMCP 登录接口，请升级 VPS 上的 WebDesktop。'),{code:'CLOUDCLI_PROTOCOL_REQUIRED'});
  const desktopOrigin=cloudcliOrigin(data.desktopOrigin);
  if(new URL(origin).protocol==='https:'&&new URL(desktopOrigin).protocol!=='https:')throw Error('CloudCLI 的工具连接地址必须使用 HTTPS。');
  return {origin,desktopOrigin};
}
// Windows stores only DPAPI ciphertext here; macOS stores only a Keychain reference.
export function readCloudcliLogins(directory){
  const file=path.join(directory,'cloudcli-logins.json');let value;
  try{const meta=fs.lstatSync(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.size>1024*1024)throw Error('Invalid CloudCLI state');value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(value?.schema!==1||!Array.isArray(value.logins)||value.logins.length>100)throw Error('Invalid CloudCLI state');
  const seen=new Set();return value.logins.map(login=>{const id=login.id??login.name;if(typeof id!=='string'||!id||id.length>480||seen.has(id)||typeof login.autoLogin!=='boolean')throw Error('Invalid CloudCLI login');seen.add(id);return {...login,id,url:cloudcliOrigin(login.url)};});
}
export function cloudcliTargets(logins){return logins.map(l=>({name:cloudcliName(l.id??l.name),url:l.url,authMode:'cloudcli',autoLogin:l.autoLogin===true,stamp:JSON.stringify([l.url,l.autoLogin,l.secret,l.credentialId])}));}
