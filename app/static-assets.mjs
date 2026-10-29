// Process-lifetime cache for public, immutable Next build assets. No disk IO.
const MIME = /^(?:application\/(?:javascript|x-javascript|font-woff|octet-stream)|text\/(?:javascript|css)|font\/(?:woff2?|ttf|otf))(?:;|$)/i;
const TYPES = /\.(?:js|css|woff2?|ttf|otf)$/i;
const RESPONSE_HEADERS = new Set(['content-type','content-encoding','etag','last-modified','vary','content-security-policy','cross-origin-resource-policy','x-content-type-options','referrer-policy']);

export class StaticAssetCache {
  constructor({maxBytes=32*1024*1024,maxEntryBytes=2*1024*1024,maxPendingBytes=8*1024*1024,maxEntries=256}={}) {
    for(const n of [maxBytes,maxEntryBytes,maxPendingBytes,maxEntries])if(!Number.isSafeInteger(n)||n<1)throw Error('Invalid static cache budget');
    this.maxBytes=maxBytes;this.maxEntryBytes=maxEntryBytes;this.maxPendingBytes=maxPendingBytes;
    this.maxEntries=maxEntries;this.entries=new Map();this.pending=new Set();this.bytes=0;this.pendingBytes=0;
  }
  key(url,method,headers={}) {
    if(!['GET','HEAD'].includes(method)||!url.pathname.startsWith('/_next/static/')||!TYPES.test(url.pathname)||url.search||/%|\\/.test(url.pathname))return null;
    if(headers.range||headers['if-range']||headers['if-none-match']||headers['if-modified-since']||headers['if-match']||headers['if-unmodified-since']||headers['transfer-encoding']||Number(headers['content-length']||0))return null;
    const encoding=String(headers['accept-encoding']||'').trim().toLowerCase();
    if(encoding.length>256||!/^[a-z0-9,;=. *-]*$/.test(encoding))return null;
    return JSON.stringify([url.origin,url.pathname,encoding]);
  }
  get(key) {
    if(!key)return null;
    const entry=this.entries.get(key);
    if(entry){this.entries.delete(key);this.entries.set(key,entry);}
    return entry||null;
  }
  capture(key,response,outputHeaders,active) {
    if(!key||response.statusCode!==200)return;
    const h=response.headers,policy=String(h['cache-control']||'');
    // Only a server's explicit public + immutable commitment permits reuse
    // without revalidation until exit. Never infer that from an extension alone.
    if(!/(?:^|,)\s*public\s*(?:,|$)/i.test(policy)||!/(?:^|,)\s*immutable\s*(?:,|$)/i.test(policy)||/(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(policy))return;
    if(!/(?:^|,)\s*max-age\s*=\s*[1-9][0-9]*\s*(?:,|$)/i.test(policy)||h['set-cookie']||h['content-disposition']||h['content-range']||!MIME.test(String(h['content-type']||'')))return;
    if(String(h.vary||'').split(',').some(s=>s.trim()&&s.trim().toLowerCase()!=='accept-encoding'))return;
    const length=h['content-length']===undefined?null:Number(h['content-length']);
    if(length!==null&&(!Number.isSafeInteger(length)||length<0||length>this.maxEntryBytes))return;
    const reservation=length===null?this.maxEntryBytes:Math.max(length,1);
    if(reservation>this.maxPendingBytes-this.pendingBytes)return;
    const chunks=[];let size=0,done=false;
    const release=()=>{
      if(done)return;done=true;this.pending.delete(cancel);this.pendingBytes-=reservation;
      response.removeListener('data',data);response.removeListener('end',end);response.removeListener('error',cancel);response.removeListener('close',cancel);chunks.length=0;
    };
    const cancel=()=>release();
    const data=chunk=>{size+=chunk.length;if(size>reservation||size>this.maxEntryBytes||!active())return cancel();chunks.push(chunk);};
    const end=()=>{
      if(done)return;
      if(!active()||!response.complete||(length!==null&&size!==length)){cancel();return;}
      const body=Buffer.concat(chunks,size),headers={};
      for(const [name,value] of Object.entries(outputHeaders))if(RESPONSE_HEADERS.has(name.toLowerCase()))headers[name]=value;
      // Browser storage stays disabled; this cache alone owns the lifetime.
      headers['cache-control']='no-store';headers['content-length']=body.length;
      release();
      if(body.length>this.maxBytes)return;
      const previous=this.entries.get(key);if(previous){this.bytes-=previous.body.length;this.entries.delete(key);}
      while((this.bytes+body.length>this.maxBytes||this.entries.size>=this.maxEntries)&&this.entries.size){const oldest=this.entries.keys().next().value;this.bytes-=this.entries.get(oldest).body.length;this.entries.delete(oldest);}
      this.entries.set(key,{headers,body});this.bytes+=body.length;
    };
    this.pending.add(cancel);this.pendingBytes+=reservation;
    response.on('data',data);response.once('end',end);response.once('error',cancel);response.once('close',cancel);
  }
  clear() {
    for(const cancel of this.pending)cancel();
    this.entries.clear();this.bytes=0;
  }
}

export const staticAssets = new StaticAssetCache();
