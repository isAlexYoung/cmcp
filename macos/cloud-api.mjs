import fs from 'node:fs';
import {Cloud as BaseCloud,shellQuote} from '../app/cloud-connector.mjs';
import {login,agentFor} from '../app/link-client.mjs';
import {prepareRelay} from '../app/terminal-link.mjs';
export {shellQuote};
export class Cloud extends BaseCloud {
  close(){this.agent?.destroy();}
  static async connect(url,password,proxy){const agent=agentFor(url,proxy);try{return new Cloud(url,await login(url,password,agent,false),agent);}catch(e){agent?.destroy();throw e;}}
  async install(){
    const {home,file}=await prepareRelay(this.url,this.cookie,this.agent,this.signal);
    const dir=file.slice(0,file.lastIndexOf('/')),target=dir+'/cloudpc-connector-mac.py';
    await this.setFile(target,fs.readFileSync(new URL('./cloudpc-connector.py',import.meta.url),'utf8'));
    const output=await this.command(`python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 79)' && chmod 700 ${shellQuote(dir)} && chmod 600 ${shellQuote(target)} && python3 ${shellQuote(target)} install --wait 60`,home,240000);
    if(!/Connected: \d+ Mac tools/.test(output)||!/Config changed: \d+/.test(output))throw Error('云端未确认 Mac 工具连接');
    return /Config changed: [1-9]|Connector updated: yes/.test(output);
  }
}
