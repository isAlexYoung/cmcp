import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
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
export function createMacTools({roots,platform=process.platform}){
  const sessions=new Map(),validate=validator(macDefinitions);
  const working=value=>{const dir=value??os.homedir();if(!path.isAbsolute(dir)||!fs.statSync(dir).isDirectory())throw Error('cwd must be an existing absolute directory');return dir;};
  function kill(s,signal='SIGTERM'){
    if(!s.child.pid)return;
    // A live child owns this PGID. Once close is emitted, never signal a reused PID.
    if(s.closed)return;
    try{if(platform==='win32')s.child.kill(signal);else process.kill(-s.child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}
  }
  function stop(s){if(s.closed)return;kill(s);if(!s.killTimer){s.killTimer=setTimeout(()=>kill(s,'SIGKILL'),1500);s.killTimer.unref();}}
  function start(program,args,dir,keepInput=false){
    for(const[id,s]of sessions)if(s.closed&&Date.now()-s.ended>30*60000)sessions.delete(id);
    if(sessions.size>=32||[...sessions.values()].filter(s=>!s.closed).length>=8)throw Error('Managed process limit reached');
    if(typeof program!=='string'||program.includes('\0')||program.startsWith('-'))throw Error('Invalid program');
    const jobCwd=working(dir),posix=platform!=='win32';
    const child=spawn(posix?process.execPath:program,posix?[path.join(KIT,'process-worker.mjs')]:args,{cwd:jobCwd,env:{...process.env},detached:posix,windowsHide:true,stdio:posix?['pipe','pipe','pipe','ipc']:['pipe','pipe','pipe']});
    const id=randomUUID(),s={id,child,output:[],bytes:0,truncated:false,closed:false,exit_code:null,signal:null,started:new Date().toISOString()};sessions.set(id,s);
    s.done=new Promise(resolve=>{s.resolve=resolve;});
    const output=chunk=>{const room=2*1024*1024-s.bytes;if(room>0){s.output.push(chunk.subarray(0,room));s.bytes+=Math.min(room,chunk.length);}if(chunk.length>room)s.truncated=true;};
    child.stdout.on('data',output);child.stderr.on('data',output);child.stdin.on('error',()=>{});
    child.on('error',e=>output(Buffer.from('Spawn error: '+e.code)));
    child.on('message',m=>{if(m?.t!=='complete')return;s.completed=m;if(m.error)output(Buffer.from('Spawn error: '+m.error));kill(s,'SIGKILL');});
    child.on('close',(code,signal)=>{s.closed=true;s.ended=Date.now();s.exit_code=s.completed?s.completed.code:code;s.signal=s.completed?s.completed.signal:signal;clearTimeout(s.killTimer);s.resolve();});
    if(posix)child.once('spawn',()=>child.send({t:'start',program,args,cwd:jobCwd}));
    if(!keepInput)child.stdin.end();return s;
  }
  const view=s=>({session_id:s.id,running:!s.closed,exit_code:s.exit_code,signal:s.signal,started:s.started,output:Buffer.concat(s.output).toString('utf8'),truncated:s.truncated});
  const get=id=>{const s=sessions.get(id);if(!s)throw Error('Unknown session; service may have restarted');return s;};
  async function foreground(program,args,a){const s=start(program,args,a.cwd);const timer=setTimeout(()=>{s.timedOut=true;stop(s);},a.timeout_ms??30000);try{await s.done;return result({...view(s),timed_out:s.timedOut===true});}finally{clearTimeout(timer);sessions.delete(s.id);}}
  async function call(name,a){
    validate(name,a);
    if(name==='mac_system_info')return result({platform,release:os.release(),arch:os.arch(),hostname:os.hostname(),home:os.homedir(),user:os.userInfo().username,allowed_roots:roots});
    if(name==='mac_toolchain_info'){
      const found={};for(const name of ['git','python3','node','npm','xcodebuild','swift','clang','java','adb']){
        found[name]=(process.env.PATH??'').split(path.delimiter).map(p=>path.join(p,name)).find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile();}catch{return false;}})??null;
      }return result(found);
    }
    if(name==='mac_execute')return foreground(a.shell==='bash'?'/bin/bash':'/bin/zsh',['-c',a.command],a);
    if(name==='mac_run_program')return foreground(a.program,a.args??[],a);
    if(name==='mac_adb')return foreground('adb',a.args,a);
    if(name==='mac_start_process')return result(view(start(a.program,a.args??[],a.cwd,true)));
    if(name==='mac_list_processes')return result({sessions:[...sessions.values()].map(view)});
    if(name==='mac_process_status')return result(view(get(a.session_id)));
    if(name==='mac_stop_process'){const s=get(a.session_id);stop(s);return result({session_id:s.id,stop_requested:!s.closed});}
    if(name==='mac_process_stdin'){
      const s=get(a.session_id);if(s.closed||s.child.stdin.destroyed||s.child.stdin.writableEnded)throw Error('Process stdin is closed');
      if(a.data)await new Promise((resolve,reject)=>s.child.stdin.write(a.data,e=>e?reject(e):resolve()));if(a.close)s.child.stdin.end();return result({sent:true});
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
  return{definitions:macDefinitions,owns:name=>macDefinitions.some(d=>d.name===name),call,async close(){for(const s of sessions.values())stop(s);await Promise.all([...sessions.values()].map(s=>s.done));}};
}
