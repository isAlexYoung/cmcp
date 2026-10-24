// Stay alive as POSIX group leader until the parent explicitly tears down the group.
// This keeps the PGID owned while descendants are being cleaned up.
import {spawn} from 'node:child_process';
let started=false;
const keepAlive=setInterval(()=>{},60000);
const destroy=()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}};
process.on('disconnect',destroy);
process.on('SIGTERM',()=>{});
process.on('message',m=>{
  if(started||m?.t!=='start')return;
  started=true;
  let done=false;
  const finish=(code,signal,error)=>{if(done)return;done=true;process.send?.({t:'complete',code,signal,error});};
  try{
    const child=spawn(m.program,m.args,{cwd:m.cwd,env:process.env,stdio:'inherit',detached:false});
    child.on('error',e=>finish(null,null,e.code));
    child.on('exit',(code,signal)=>finish(code,signal));
  }catch(e){finish(null,null,e.code||'SPAWN_ERROR');}
});
