import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {define,str,integer,validator,result} from './schema.mjs';
import {KIT,runFile} from './platform.mjs';
const argv={type:'array',items:{type:'string',maxLength:32768},maxItems:256};
const cwd={type:'string',minLength:1};
const execution={cwd,timeout_ms:integer(100,120000)};
export const macDefinitions=[
  define('mac_system_info','Get OS, architecture, home, user and allowed file roots.',{},[],true),
  define('mac_toolchain_info','Locate common developer tools in the service PATH.',{},[],true),
  define('mac_execute','Execute a shell command on the physical Mac with current user permissions. Not a filesystem sandbox. Output capped at 2 MiB.',{command:str,shell:{enum:['zsh','bash']},...execution},['command']),
  define('mac_run_program','Run a program with an argument array, without shell interpolation.',{program:str,args:argv,...execution},['program']),
  define('mac_start_process','Start a managed background program. Returns an opaque session ID.',{program:str,args:argv,cwd},['program']),
  define('mac_process_status','Get output and exit status of a managed process.',{session_id:str},['session_id'],true),
  define('mac_process_stdin','Write stdin to a managed process, optionally close stdin.',{session_id:str,data:{type:'string',maxLength:65536},close:{type:'boolean'}},['session_id']),
  define('mac_stop_process','Stop only a process group created by this service, using its session ID.',{session_id:str},['session_id']),
  define('mac_list_processes','List managed sessions; no arbitrary PID control.',{},[],true),
  define('mac_open_url','Open an HTTP or HTTPS URL with the default Mac browser.',{url:str},['url']),
  define('mac_open_path','Open an existing absolute path with the default Mac application.',{path:str},['path']),
  define('mac_screenshot','Capture screen to a NEW PNG in an allowed directory. Screen Recording permission may be needed.',{path:str},['path']),
  define('mac_desktop_action','Move/click the mouse, type text or press keys on the current Mac desktop. Requires Accessibility permission.',{action:{enum:['move_mouse','click','double_click','type_text','press_keys','hotkey']},x:integer(0,65535),y:integer(0,65535),text:{type:'string',maxLength:10000},keys:{type:'array',items:{type:'string',maxLength:32},maxItems:8},button:{enum:['left','right','middle']}},['action']),
  define('mac_keyboard','Send text or a limited key to the foreground Mac app. Requires Accessibility/Automation approval. Text is passed on stdin.',{text:{type:'string',maxLength:16384},key:{enum:['return','tab','escape','space','backspace','left','right','up','down']},modifiers:{type:'array',items:{enum:['command','control','option','shift']},maxItems:4}},[]),
  define('mac_adb','Run Android adb on the Mac. Supply arguments as an array.',{args:argv,...execution},['args'])
];
function outputStream() {
  const decoder = new StringDecoder('utf8');
  let text = '', end = 0;
  function append(chunk) {
    end += chunk.length;
    text = (text + chunk).slice(-1048576);
  }
  return {
    write: chunk => append(decoder.write(chunk)),
    end: () => append(decoder.end()),
    read(offset, limit) {
      const start = end - text.length, requested = offset ?? Math.max(0, end - limit);
      const from = Math.max(start, Math.min(requested, end)), value = text.slice(from - start, from - start + limit);
      return {value, next: from + value.length, truncated: requested < start || (offset === undefined && from > 0), more: from + value.length < end};
    },
  };
}
export function createMacTools({roots,platform=process.platform,definitions=macDefinitions}){
  const sessions=new Map(),validate=validator(definitions),linux=platform==='linux'&&definitions!==macDefinitions;
  const working=value=>{const dir=value??os.homedir();if(!path.isAbsolute(dir)||!fs.statSync(dir).isDirectory())throw Error('cwd must be an existing absolute directory');return dir;};
  function kill(s,signal='SIGTERM'){
    if(!s.child.pid)return;
    // A live child owns this PGID. Once close is emitted, never signal a reused PID.
    if(s.closed)return;
    try{if(platform==='win32')s.child.kill(signal);else process.kill(-s.child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}
  }
  function stop(s){if(s.closed)return;kill(s);if(!s.killTimer){s.killTimer=setTimeout(()=>kill(s,'SIGKILL'),1500);s.killTimer.unref();}}
  function start(program,args,options,keepInput=false){
    for(const[id,s]of sessions)if(s.closed&&Date.now()-s.ended>30*60000)sessions.delete(id);
    if(sessions.size>=32||[...sessions.values()].filter(s=>!s.closed).length>=8)throw Error('Managed process limit reached');
    if(typeof program!=='string'||program.includes('\0')||program.startsWith('-'))throw Error('Invalid program');
    const jobCwd=working(options.cwd),posix=platform!=='win32';
    const child=spawn(posix?process.execPath:program,posix?[path.join(KIT,'process-worker.mjs')]:args,{cwd:jobCwd,env:{...process.env},detached:posix,windowsHide:true,stdio:posix?['pipe','pipe','pipe','ipc']:['pipe','pipe','pipe']});
    const id=randomUUID(),s={id,child,cwd:jobCwd,output:[],bytes:0,truncated:false,closed:false,exit_code:null,signal:null,started:new Date().toISOString()};sessions.set(id,s);
    if(linux){s.stdout=outputStream();s.stderr=outputStream();}
    s.done=new Promise(resolve=>{s.resolve=resolve;});
    const output=chunk=>{const room=2*1024*1024-s.bytes;if(room>0){s.output.push(chunk.subarray(0,room));s.bytes+=Math.min(room,chunk.length);}if(chunk.length>room)s.truncated=true;};
    child.stdout.on('data',chunk=>{output(chunk);s.stdout?.write(chunk);});
    child.stderr.on('data',chunk=>{output(chunk);s.stderr?.write(chunk);});
    child.stdin.on('error',()=>{});
    const spawnError=code=>{s.error='Spawn error: '+code;const message=Buffer.from(s.error);output(message);s.stderr?.write(message);};
    child.on('error',e=>spawnError(e.code));
    child.on('message',m=>{if(m?.t!=='complete')return;s.completed=m;if(m.error)spawnError(m.error);kill(s,'SIGKILL');});
    child.on('close',(code,signal)=>{
      s.stdout?.end();s.stderr?.end();s.closed=true;s.ended=Date.now();s.exit_code=s.completed?s.completed.code:code;
      s.signal=s.completed?s.completed.signal:signal;clearTimeout(s.killTimer);clearTimeout(s.deadline);s.resolve();
    });
    if(posix)child.once('spawn',()=>child.send({t:'start',program,args,cwd:jobCwd,env:options.env}));
    if(!keepInput)child.stdin.end();return s;
  }
  function view(s,options={}){
    const legacy={session_id:s.id,running:!s.closed,exit_code:s.exit_code,signal:s.signal,started:s.started,output:Buffer.concat(s.output).toString('utf8'),truncated:s.truncated};
    if(!linux)return legacy;
    const limit=options.output_limit??30000;
    const stdout=s.stdout.read(options.stdout_offset,limit),stderr=s.stderr.read(options.stderr_offset,limit);
    return {...legacy,cwd:s.cwd,stdout:stdout.value,stderr:stderr.value,next_stdout_offset:stdout.next,next_stderr_offset:stderr.next,
      stdout_truncated:stdout.truncated,stderr_truncated:stderr.truncated,stdout_more:stdout.more,stderr_more:stderr.more,
      timed_out:s.timedOut===true,...s.error?{error:s.error}:{}};
  }
  const get=id=>{const s=sessions.get(id);if(!s)throw Error('Unknown session; service may have restarted');return s;};
  function setDeadline(s, milliseconds) {
    if(milliseconds) s.deadline=setTimeout(()=>{s.timedOut=true;stop(s);},milliseconds);
  }
  async function waitFor(s, milliseconds) {
    if(!milliseconds||s.closed)return;
    let timer;
    try{await Promise.race([s.done,new Promise(resolve=>{timer=setTimeout(resolve,milliseconds);})]);}
    finally{clearTimeout(timer);}
  }
  async function foreground(program,args,a){
    const s=start(program,args,a);setDeadline(s,a.timeout_ms??30000);
    try{
      await s.done;
      const reply=result({...view(s,a),timed_out:s.timedOut===true});
      if(linux&&(s.timedOut||s.error||s.exit_code!==0))reply.isError=true;
      return reply;
    }finally{clearTimeout(s.deadline);sessions.delete(s.id);}
  }
  async function call(name,a){
    validate(name,a);
    if(name==='mac_system_info')return result({platform,release:os.release(),arch:os.arch(),hostname:os.hostname(),home:os.homedir(),user:os.userInfo().username,allowed_roots:roots});
    if(name==='mac_toolchain_info'){
      const found={};for(const name of ['git','python3','node','npm','xcodebuild','swift','clang','java','adb']){
        found[name]=(process.env.PATH??'').split(path.delimiter).map(p=>path.join(p,name)).find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile();}catch{return false;}})??null;
      }return result(found);
    }
    if(name==='mac_execute')return foreground(a.shell==='bash'?'/bin/bash':'/bin/zsh',['-c',a.command],a);
    if(name==='mac_run_program')return foreground(a.program??a.executable,a.args??[],a);
    if(name==='mac_adb')return foreground('adb',a.args,a);
    if(name==='mac_start_process'){
      const s=a.command===undefined?start(a.program,a.args??[],a,true):start('/bin/bash',['-c',a.command],a,true);
      setDeadline(s,a.timeout_ms);
      return result(view(s));
    }
    if(name==='mac_list_processes')return result({sessions:[...sessions.values()].map(s=>view(s))});
    if(name==='mac_list_sessions'){
      return result({sessions:[...sessions.values()].map(s=>({
        session_id:s.id,pid:s.child.pid??null,cwd:s.cwd,running:!s.closed,exit_code:s.exit_code,started_at:s.started,
      }))});
    }
    if(name==='mac_process_status'){const s=get(a.session_id);await waitFor(s,a.wait_ms);return result(view(s,a));}
    if(name==='mac_stop_process'){
      const s=get(a.session_id),requested=!s.closed;stop(s);
      if(!linux)return result({session_id:s.id,stop_requested:requested});
      await waitFor(s,5000);return result({...view(s),stop_requested:requested});
    }
    if(name==='mac_process_stdin'){
      const s=get(a.session_id);if(s.closed||s.child.stdin.destroyed||s.child.stdin.writableEnded)throw Error('Process stdin is closed');
      if(a.data)await new Promise((resolve,reject)=>s.child.stdin.write(a.data,e=>e?reject(e):resolve()));if(a.close)s.child.stdin.end();
      return result(linux?{sent:true,session_id:s.id,sent_characters:(a.data??'').length,stdin_closed:a.close===true}:{sent:true});
    }
    if(platform!=='darwin')throw Error('This tool requires macOS');
    if(name==='mac_desktop_action'){
      const executable=path.resolve(KIT,'../../MacOS/CMCP');
      if(!fs.existsSync(executable))throw Error('Desktop actions require the packaged CMCP application');
      await runFile(executable,['--desktop-action'],{input:JSON.stringify(a)});return result({sent:true});
    }
    if(name==='mac_open_url'){const u=new URL(a.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Only HTTP/HTTPS URLs without credentials are supported');await runFile('/usr/bin/open',[u.href]);return result({opened:u.href});}
    if(name==='mac_open_path'){if(!path.isAbsolute(a.path))throw Error('Use an absolute path');const file=fs.realpathSync(a.path);await runFile('/usr/bin/open',['--',file]);return result({opened:file});}
    if(name==='mac_screenshot'){
      if(!path.isAbsolute(a.path)||!a.path.toLowerCase().endsWith('.png'))throw Error('Use an absolute .png path');
      const parent=fs.realpathSync(path.dirname(a.path));const file=path.join(parent,path.basename(a.path));
      if(!roots.some(r=>{const rel=path.relative(fs.realpathSync(r),file);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}))throw Error('Screenshot outside allowed roots');
      // Reserve the destination exclusively; capture to a private subdirectory then publish without overwrite.
      const dir=fs.mkdtempSync(path.join(parent,'.mcp-screen-'));fs.chmodSync(dir,0o700);const temp=path.join(dir,'screen.png');
      try{await runFile('/usr/sbin/screencapture',['-x','-t','png',temp]);if(!fs.statSync(temp).size)throw Error('Screenshot is empty; check Screen Recording permission');fs.chmodSync(temp,0o600);fs.linkSync(temp,file);return result({path:file});}
      finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
    if(name==='mac_keyboard'){if((a.text===undefined)===(a.key===undefined))throw Error('Supply exactly one of text or key');await runFile('/usr/bin/osascript',['-l','JavaScript',path.join(KIT,'keyboard.jxa')],{input:JSON.stringify(a)});return result({sent:true});}
    throw Error('Unknown tool');
  }
  return{definitions,owns:name=>definitions.some(d=>d.name===name),call,async close(){for(const s of sessions.values())stop(s);await Promise.all([...sessions.values()].map(s=>s.done));}};
}
