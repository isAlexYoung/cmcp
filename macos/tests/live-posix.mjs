// Optional integration check. Credentials are accepted on stdin only.
// Uses a disposable directory and a separate cloud terminal; never opens the MCP link.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Cloud,shellQuote as q} from '../cloud-api.mjs';
const chunks=[];for await(const b of process.stdin)chunks.push(b);
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const archive=fs.readFileSync(input.archive).toString('base64');
for(const target of input.targets){
  const cloud=await Cloud.connect(target.url,target.password,input.proxy??'');let dir;
  try{
    const info=await cloud.api('/api/sys/info?lite=1');
    if(typeof info.home!=='string'||!/^\/[a-zA-Z0-9_./-]+$/.test(info.home)||info.home.split('/').includes('..'))throw Error('Invalid cloud home');
    dir=info.home+'/.mac-mcp-review-'+randomUUID();
    await cloud.command(`umask 077; mkdir ${q(dir)}`,info.home,30000);
    let count=0;
    for(let offset=0;offset<archive.length;offset+=1024*1024){await cloud.setFile(dir+'/part-'+String(count++).padStart(4,'0'),archive.slice(offset,offset+1024*1024));}
    const cmd=`set -e; cd ${q(dir)}; cat part-* | base64 -d > suite.tar.gz; tar -xzf suite.tar.gz; node --version; node --test tests/*.test.mjs; python3 -m unittest discover -s tests -p '*_test.py' -v`;
    console.log('REMOTE '+target.url);console.log(await cloud.command(cmd,dir,120000));
  }finally{if(dir)await cloud.command('rm -rf -- '+q(dir),'/home/user',30000).catch(()=>{});cloud.close();}
}
