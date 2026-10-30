import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {performance} from 'node:perf_hooks';

const pool = {keepAlive:true, keepAliveMsecs:1000, maxSockets:8, maxFreeSockets:2, scheduling:'lifo',rejectUnauthorized:true};

// Errors carry fixed phase names and timing only: no URL, proxy credentials or headers.
export function observeRequest(req) {
  const started=performance.now();
  let phase='connection-queue', socket;
  const connected=()=>{phase=socket.encrypted?'tls-handshake':'http-response';};
  const secured=()=>{phase='http-response';};
  const decorate=error=>{
    error.connectionPhase ||= phase;
    error.connectionMs ??= Math.round(performance.now()-started);
    error.reusedConnection ??= !!req.reusedSocket;
    return error;
  };
  req.once('socket',s=>{
    socket=s;
    phase=req.reusedSocket?'http-response':s.encrypted ? (s.secureConnecting?'tls-handshake':'http-response') : (s.connecting?'tcp-connect':'http-response');
    if(!req.reusedSocket){s.once('connect',connected);s.once('secureConnect',secured);}
  });
  req.once('response',res=>{phase='http-body';res.once('error',decorate);});
  req.once('upgrade',()=>{phase='websocket';});
  req.prependOnceListener('error',decorate);
  req.once('close',()=>{socket?.removeListener('connect',connected);socket?.removeListener('secureConnect',secured);});
  return decorate;
}

export function finishSocketRequest(req) { observeRequest(req); req.end(); }

export function connectionDetail(error) {
  const phase=/^(connection-queue|tcp-connect|proxy-connect|proxy-tls|tls-handshake|http-response|http-body|websocket)$/.test(error?.connectionPhase||'')?error.connectionPhase:'unknown';
  const ms=Number.isFinite(error?.connectionMs)?Math.max(0,Math.round(error.connectionMs)):0;
  return `phase=${phase} elapsedMs=${ms} reused=${error?.reusedConnection===true}`;
}

export function agentFor(url, proxyUrl) {
  if(!url.startsWith('https:'))return undefined;
  const agent=new https.Agent(pool);
  if(!proxyUrl)return agent;
  const proxy=new URL(proxyUrl);
  if(!['http:','https:'].includes(proxy.protocol))throw Error('Only HTTP/HTTPS CONNECT proxies are supported');
  const auth=proxy.username?'Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64'):'';
  const pending=new Set();
  const destroy=agent.destroy.bind(agent);
  agent.destroy=()=>{for(const s of pending)s.destroy();pending.clear();destroy();};
  agent.createConnection=(options,callback)=>{
    const host=options.host||options.hostname, port=options.port||443;
    const started=performance.now();
    let done=false, phase=proxy.protocol==='https:'?'proxy-tls':'proxy-connect';
    const proxyOptions={host:proxy.hostname.replace(/^\[|\]$/g,''),port:Number(proxy.port)||(proxy.protocol==='https:'?443:80)};
    const socket=proxy.protocol==='https:'?tls.connect({...proxyOptions,rejectUnauthorized:true,servername:net.isIP(proxyOptions.host)?undefined:proxyOptions.host}):net.connect(proxyOptions);
    pending.add(socket);
    const fail=error=>{
      if(done)return;done=true;clearTimeout(timer);pending.delete(socket);socket.destroy();
      const wrapped=Object.assign(new Error('Proxy connection failed'),{code:'PROXY_FAILED',cause:error,connectionPhase:phase,connectionMs:Math.round(performance.now()-started)});
      callback(wrapped);
    };
    const timer=setTimeout(()=>fail(Object.assign(Error('proxy timeout'),{code:'ETIMEDOUT'})),20000);
    socket.once('error',fail);
    socket.once('close',()=>{if(!done)fail(Object.assign(Error('proxy connection closed'),{code:'ECONNRESET'}));});
    socket.once(proxy.protocol==='https:'?'secureConnect':'connect',()=>{
      phase='proxy-connect';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`+(auth?`Proxy-Authorization: ${auth}\r\n`:'')+'\r\n');
    });
    let head=Buffer.alloc(0);
    const onData=chunk=>{
      head=Buffer.concat([head,chunk]);const end=head.indexOf('\r\n\r\n');
      if(end<0){if(head.length>16384)fail(Error('Proxy response too large'));return;}
      socket.removeListener('data',onData);
      const status=Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1]);
      if(status!==200)return fail(Object.assign(Error('Proxy CONNECT rejected'),{status}));
      if(head.length>end+4)return fail(Error('Unexpected proxy tunnel bytes'));
      clearTimeout(timer);socket.removeListener('error',fail);pending.delete(socket);
      const secure=tls.connect({...options,socket,rejectUnauthorized:true,servername:options.servername||(net.isIP(host)?'':host),ALPNProtocols:['http/1.1']});
      done=true;callback(null,secure);
    };
    socket.on('data',onData);
    return undefined;
  };
  return agent;
}
