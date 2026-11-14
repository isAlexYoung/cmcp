// Managed background SSH connections silently repair one changed/unknown host key.
// The normal attempt verifies strictly; only its host-key failure permits one targeted reset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const hostKeyFailure = text => /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text);
const read = file => { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const same = (a,b) => a === null ? b === null : b !== null && a.equals(b);
const abort = signal => { if (signal.aborted) throw signal.reason; };

export const HOST_KEY_RECOVERY_ERROR = 'SSH 主机指纹自动恢复失败，请检查服务器及本机 known_hosts 文件权限。';

// Serialize resets across the web manager and the separate MCP workers. If another
// connection already changed the file, verify its result instead of deleting a newly trusted key.
async function resetHost({file, original, target, keygen, env, signal, spawnProcess}) {
  abort(signal);
  if (!original) return;
  const lock = file + '.cmcp-host-key-lock', token = process.pid + ':' + randomUUID();
  const deadline = Date.now() + 10000;
  while (true) {
    abort(signal);
    try { fs.writeFileSync(lock, token, {flag:'wx',mode:0o600}); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = read(lock)?.toString();
      const pid = Number(owner?.split(':')[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid,0); }
        catch (error) { if (error.code === 'ESRCH' && read(lock)?.toString() === owner) { fs.unlinkSync(lock); continue; } }
      }
      if (Date.now() >= deadline) throw Error('Host key reset is busy');
      await delay(40,undefined,{signal});
    }
  }
  try {
    abort(signal);
    if (!same(original,read(file))) return;
    await new Promise((resolve,reject) => {
      let child, done = false;
      const finish = error => {
        if (done) return;
        done = true; clearTimeout(timer); signal.removeEventListener('abort',cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => { child?.kill(); finish(signal.reason); };
      const timer = setTimeout(() => { child?.kill(); finish(Error('Host key reset timed out')); },8000);
      signal.addEventListener('abort',cancel,{once:true});
      try {
        abort(signal);
        child = spawnProcess(keygen,['-R',target,'-f',file],{env,windowsHide:true,stdio:['ignore','ignore','ignore']});
        child.once('error',finish);
        child.once('close',code => finish(code === 0 ? null : Error('Host key reset failed')));
      } catch (error) { finish(error); }
    });
  } finally { if (read(lock)?.toString() === token) fs.unlinkSync(lock); }
}

/** Child-process facade shared by WebDesktop/ClaudeWeb tunnels, MCP and CloudCLI setup. */
export function spawnSshWithRecovery(ssh,args,options,{login,spawnProcess=spawn,input,endInput=false,
  knownHostsFile=path.join(os.homedir(),'.ssh','known_hosts')}={}) {
  const at = args.indexOf('--');
  if (at < 0 || args[at+1] !== login?.host || !Number.isInteger(login.port) || login.port < 1 || login.port > 65535) throw Error('Invalid SSH target');
  const file = path.resolve(knownHostsFile), original = read(file);
  const target = login.port === 22 ? login.host : '[' + login.host + ']:' + login.port;
  const keygen = path.dirname(ssh) === '.' ? 'ssh-keygen' : path.join(path.dirname(ssh),'ssh-keygen' + (process.platform === 'win32' ? '.exe' : ''));
  const result = new EventEmitter(), controller = new AbortController();
  result.stdout = new PassThrough(); result.stderr = new PassThrough();
  let current, stopped = false, completed = false, retried = false, receivedOutput = false, exitImmediate;
  Object.defineProperty(result,'stdin',{get:() => current?.stdin});
  Object.defineProperty(result,'pid',{get:() => current?.pid});
  result.kill = (...values) => {
    if (completed) return false;
    stopped = true; controller.abort(); clearImmediate(exitImmediate);
    const killed = current?.kill(...values);
    queueMicrotask(() => complete(null,typeof values[0] === 'string' ? values[0] : 'SIGTERM',''));
    return killed;
  };
  const complete = (code,signal,stderr) => {
    if (completed) return;
    completed = true;
    if (stderr) result.stderr.write(stderr);
    result.stdout.end(); result.stderr.end();
    result.emit('exit',code,signal); result.emit('close',code,signal);
  };
  const start = () => {
    let stderr = '', finished = false;
    const extra = ['-o','StrictHostKeyChecking=' + (retried ? 'accept-new' : 'yes'),
      '-o','UserKnownHostsFile="' + file.replace(/\\/g,'/').replace(/"/g,'\\"') + '"'];
    const argv = [...args.slice(0,at),...extra,...args.slice(at)];
    let child;
    try { child = current = spawnProcess(ssh,argv,options); }
    catch (error) { queueMicrotask(() => { result.emit('error',error); complete(null,null,''); }); return; }
    child.stdout?.on('data',chunk => { receivedOutput = true; result.stdout.write(chunk); });
    child.stderr?.on('data',chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.stdin?.on('error',() => {});
    const finish = (code,signal) => {
      if (finished) return;
      finished = true; clearImmediate(exitImmediate);
      if (!stopped && !retried && !receivedOutput && code !== 0 && hostKeyFailure(stderr)) {
        retried = true;
        resetHost({file,original,target,keygen,env:options.env,signal:controller.signal,spawnProcess}).then(() => {
          if (!stopped) start();
        }).catch(() => {
          if (!stopped) complete(255,null,'Host key verification failed. ' + HOST_KEY_RECOVERY_ERROR);
        });
        return;
      }
      complete(code,signal,stderr);
    };
    child.once('error',error => { if (!stopped) result.emit('error',error); });
    // close includes the last stderr chunk; exit also supports existing process adapters.
    child.once('exit',(code,signal) => { exitImmediate = setImmediate(() => finish(code,signal)); });
    child.once('close',finish);
    if (input !== undefined) endInput ? child.stdin.end(input) : child.stdin.write(input);
  };
  start();
  return result;
}
