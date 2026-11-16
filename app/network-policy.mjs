import fs from 'node:fs';
import path from 'node:path';

// Only network fields affect live connections. Theme/language edits must not reconnect.
export function networkRevision(stateDir) {
  try {
    const file=path.join(stateDir,'application-preferences.json');
    if(fs.statSync(file).size>32768)return 'invalid';
    const settings=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    if(settings.schema!==1)return 'invalid';
    const mode=settings.proxyMode??'auto';
    if(!['auto','manual','direct'].includes(mode))return 'invalid';
    return JSON.stringify(mode==='manual'?[mode,settings.proxyHost,settings.proxyPort]:[mode]);
  } catch(error) { return error.code==='ENOENT'?'["auto"]':'invalid'; }
}
