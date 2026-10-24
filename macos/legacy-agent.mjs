import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LABEL,runFile,safeFile} from './platform.mjs';

// Retire only this kit's previous launchd entry. Preserve its file as a backup.
export async function retireLegacyAgent({home,state,uid,run=runFile}){
  const file=path.join(home,'Library/LaunchAgents',LABEL+'.plist');
  safeFile(file);if(!fs.existsSync(file))return false;
  const before=fs.readFileSync(file);
  const document=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',file]));
  if(document.Label!==LABEL||!Array.isArray(document.ProgramArguments)||document.ProgramArguments.length!==2||document.ProgramArguments[1]!==path.join(state,'app/service.mjs'))throw Error('Legacy login item does not match this application');
  const target=`gui/${uid}/${LABEL}`;
  let loaded=false;try{await run('/bin/launchctl',['print',target],{timeout:5000});loaded=true;}catch{}
  if(loaded)await run('/bin/launchctl',['bootout',target],{timeout:10000});
  safeFile(file);if(!fs.readFileSync(file).equals(before))throw Error('Legacy login item changed during migration');
  fs.renameSync(file,file+'.cmcp-disabled-'+randomUUID());
  return true;
}
