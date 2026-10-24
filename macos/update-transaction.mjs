import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runFile,privateDir,safeFile} from './platform.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
export function inspectZip(bytes){
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}}
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)throw Error('Invalid ZIP directory');
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
  if(!count||count>20000||count!==bytes.readUInt16LE(end+8)||offset+size>end||count===65535)throw Error('Unsupported ZIP');
  let position=offset,total=0;const names=new Set();
  for(let i=0;i<count;i++){
    if(position+46>offset+size||bytes.readUInt32LE(position)!==0x02014b50)throw Error('Invalid ZIP member');
    const flags=bytes.readUInt16LE(position+8),method=bytes.readUInt16LE(position+10),length=bytes.readUInt32LE(position+24);
    const n=bytes.readUInt16LE(position+28),extra=bytes.readUInt16LE(position+30),comment=bytes.readUInt16LE(position+32);
    const mode=bytes.readUInt32LE(position+38)>>>16,local=bytes.readUInt32LE(position+42);
    if(position+46+n+extra+comment>offset+size||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)throw Error('Invalid local ZIP member');
    const raw=bytes.subarray(position+46,position+46+n),name=raw.toString('utf8');
    const localNameLength=bytes.readUInt16LE(local+26),localExtraLength=bytes.readUInt16LE(local+28);
    const compressed=bytes.readUInt32LE(position+20);
    if(!bytes.subarray(local+30,local+30+localNameLength).equals(raw)||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||local+30+localNameLength+localExtraLength+compressed>offset)throw Error('ZIP local/central disagreement');
    if(!Buffer.from(name).equals(raw)||!name.startsWith('CMCP.app/')||name.includes('\\')||name.includes(':')||/[\x00-\x1f\x7f]/.test(name)||name.split('/').some(p=>p==='..'||p==='.')||(flags&1)||![0,8].includes(method)||![0,0o100000,0o040000].includes(mode&0o170000))throw Error('Unsafe ZIP member');
    const key=name.normalize('NFD').toLowerCase().replace(/\/$/,'');if(names.has(key))throw Error('Duplicate ZIP path');names.add(key);
    total+=length;if(total>1024*1024*1024)throw Error('ZIP expansion too large');position+=46+n+extra+comment;
  }
  if(position!==offset+size)throw Error('Unexpected ZIP directory length');
  return {count,bytes:total};
}
export function validateBundle(bundle,{version,arch}={}){
  if(!bundle.endsWith('.app')||fs.lstatSync(bundle).isSymbolicLink())throw Error('Application directory required');
  const manifestFile=path.join(bundle,'Contents/Resources/distribution-manifest.json');safeFile(manifestFile);
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.schema!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!['macos-arm64','macos-x64'].includes(manifest.platform)||version&&manifest.version!==version||arch&&manifest.platform!=='macos-'+arch||!Array.isArray(manifest.files)||manifest.files.length>20000)throw Error('Wrong distribution manifest');
  const expected=new Map(),caseNames=new Set();
  for(const file of manifest.files){if(typeof file.path!=='string'||!file.path.startsWith('Contents/')||file.path.includes('\\')||file.path.includes(':')||file.path.split('/').some(p=>p==='..'||p==='.'||!p)||!(file.codeSignature===true&&file.path==='Contents/MacOS/CMCP'&&file.sha256===undefined||file.codeSignature===undefined&&/^[a-f0-9]{64}$/.test(file.sha256))||caseNames.has(file.path.normalize('NFD').toLowerCase()))throw Error('Invalid manifest path');expected.set(file.path,file.codeSignature===true?null:file.sha256);caseNames.add(file.path.normalize('NFD').toLowerCase());}
  const actual=new Set();
  function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),relative=path.relative(bundle,file).split(path.sep).join('/');if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw Error('Special file in application');if(entry.isDirectory())visit(file);else if(relative!=='Contents/Resources/distribution-manifest.json'&&!relative.startsWith('Contents/_CodeSignature/')){actual.add(relative);if(!expected.has(relative)||expected.get(relative)!==null&&expected.get(relative)!==hash(fs.readFileSync(file)))throw Error('Modified or extra application file');}}}
  visit(bundle);if(actual.size!==expected.size)throw Error('Missing application files');
  for(const required of ['Contents/Info.plist','Contents/MacOS/CMCP','Contents/Resources/runtime/node','Contents/Resources/macos/desktop.mjs'])if(!actual.has(required))throw Error('Incomplete application');
  // Bundle signing changes the main Mach-O executable. Its code signature covers
  // both that binary and the sealed resources (including this manifest), avoiding
  // a circular hash dependency. Every other payload retains an exact SHA-256.
  if(expected.get('Contents/MacOS/CMCP')===null){
    if(process.platform!=='darwin')throw Error('macOS code-signature verification required');
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe',timeout:30000});
  }
  return manifest;
}
export async function replaceBundle({installRoot,staged,version,arch,launch,healthy,stopFailed,run=runFile}){
  if(!path.isAbsolute(installRoot)||!path.isAbsolute(staged)||path.resolve(installRoot)===path.resolve(staged))throw Error('Invalid application paths');
  validateBundle(installRoot,{arch});validateBundle(staged,{version,arch});
  const parent=path.dirname(installRoot);privateDirCheck(parent);
  const backup=path.join(parent,'.cmcp-backup-'+randomUUID()+'.app');
  // Both mutation paths are fixed siblings of the explicitly validated app.
  if(path.dirname(backup)!==parent||!installRoot.endsWith('.app'))throw Error('Invalid backup path');
  fs.renameSync(installRoot,backup);
  try{fs.renameSync(staged,installRoot);await launch(installRoot);if(!await healthy())throw Error('New application did not become ready');}
  catch(error){if(stopFailed)await stopFailed();const failed=path.join(parent,'.cmcp-failed-'+randomUUID()+'.app');if(fs.existsSync(installRoot))fs.renameSync(installRoot,failed);fs.renameSync(backup,installRoot);await launch(installRoot,true);throw error;}
  return backup;
}
function privateDirCheck(directory){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid()&&directory!=='/Applications')throw Error('Unsafe installation parent');}
