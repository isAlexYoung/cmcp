// Authentication values stay in memory. Never include them in logs or errors.
import http from 'node:http';
import https from 'node:https';

export function authHeaders(auth) {
  if (typeof auth === 'string') return {cookie: auth};
  if (!auth || typeof auth.sessionId !== 'string' || !/^[A-Za-z0-9._~-]{16,4096}$/.test(auth.sessionId)) throw Error('Invalid desktop session');
  if (auth.cookie !== undefined && (typeof auth.cookie !== 'string' || !/^wd_session=[\x21-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(auth.cookie))) throw Error('Invalid desktop cookie');
  return {'X-Desktop-Session': auth.sessionId, ...(auth.cookie ? {cookie:auth.cookie} : {})};
}
export function authSocketUrl(url, auth) {
  const result = new URL(url);
  if (auth && typeof auth === 'object') {
    authHeaders(auth);
    result.searchParams.set('access', auth.sessionId);
  }
  return result;
}

export function socketHeaders(baseUrl,auth) {
  const url=new URL(baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid desktop origin');
  return {...authHeaders(auth),Origin:url.origin};
}

export function requestBuffered(url, {method='GET', headers={}, body, agent, signal, limit=2*1024*1024, timeout=30000}={}) {
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    if (!['http:','https:'].includes(target.protocol)) return reject(Error('Unsupported protocol'));
    const req=(target.protocol==='https:'?https:http).request(target,{method,headers,agent,signal,rejectUnauthorized:true},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>limit)req.destroy(Error('Response too large'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    const timer=setTimeout(()=>req.destroy(Object.assign(Error('Request timed out'),{code:'ETIMEDOUT'})),timeout);
    req.once('close',()=>clearTimeout(timer));req.on('error',reject);req.end(body);
  });
}

// GET only. Never probe authentication by submitting the password.
export async function requiresSharedSession(baseUrl, agent, signal) {
  const res=await requestBuffered(new URL('/api/auth/session',baseUrl),{agent,signal,limit:65536});
  let body;try{body=JSON.parse(res.body);}catch{}
  if (res.status===401 && /其他设备已登录|其他页面登录/.test(body?.error||'')) return true;
  if (res.status>=500 || res.status===429 || res.status===0) throw Error('云电脑暂时不可用，已暂停登录检查');
  if (res.status===404 || res.status===405) return false;
  if (res.status===401) throw Error('无法安全识别云电脑登录协议');
  // Older servers have no session endpoint. Inspect the public bundle if present
  // so a future wording change cannot silently re-enable password reauthentication.
  const page=await requestBuffered(new URL('/',baseUrl),{agent,signal});
  if(page.status>=500 || page.status===0)throw Error('云电脑暂时不可用，已暂停登录检查');
  const html=page.body.toString('utf8');
  const paths=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m=>new URL(m[1].replaceAll('&amp;','&'),baseUrl)).filter(u=>u.origin===new URL(baseUrl).origin);
  if(!paths.length)throw Error('无法安全识别云电脑登录协议');
  if(paths.length>20)throw Error('无法安全识别云电脑登录协议');
  for(const u of paths){
    const js=await requestBuffered(u,{agent,signal});
    if(js.status!==200)throw Error('无法读取云电脑登录协议，请稍后重试');
    const source=js.body.toString('utf8');
    if(source.includes('X-Desktop-Session') || source.includes('webdesktop-exclusive-session'))return true;
  }
  return false;
}
