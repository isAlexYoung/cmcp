import fs from 'node:fs';
import path from 'node:path';
import {LEGACY_STATE,privateDir,safeFile,atomicWrite} from './platform.mjs';
import {validateBundle} from './update-transaction.mjs';
import {completePortableUpdate} from './portable-state.mjs';
const [file,dataState,installRoot]=process.argv.slice(2);
try{
  if(process.platform!=='darwin'||path.dirname(file)!==LEGACY_STATE||dataState!==path.join(path.dirname(installRoot),'user')||!/^update-request-[a-f0-9-]{36}\.json$/.test(path.basename(file)))throw Error('Invalid legacy cleanup request');
  privateDir(LEGACY_STATE);privateDir(dataState);safeFile(file);safeFile(file+'.ack');
  const request=JSON.parse(fs.readFileSync(file,'utf8')),ack=fs.statSync(file+'.ack').mtimeMs;
  if(request.installRoot!==installRoot||request.state!==LEGACY_STATE||fs.readFileSync(file+'.ack','utf8')!==request.nonce||validateBundle(installRoot).version!==request.version)throw Error('Invalid legacy cleanup identity');
  const resultFile=path.join(LEGACY_STATE,'update-result.json');let result;
  for(let i=0;i<180;i++){
    safeFile(resultFile);
    if(fs.existsSync(resultFile)&&fs.statSync(resultFile).mtimeMs>=ack){result=JSON.parse(fs.readFileSync(resultFile,'utf8'));if(result.ok&&result.version===request.version)break;result=undefined;}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!result)throw Error('Legacy update not confirmed');
  const cleanup={state:LEGACY_STATE,dataState,installRoot,backup:result.backup,folder:request.folder,requestFile:file};
  const pending=path.join(dataState,'update-cleanup.json');atomicWrite(pending,JSON.stringify(cleanup));
  completePortableUpdate(cleanup);fs.unlinkSync(pending);
}catch{process.exitCode=1;}
