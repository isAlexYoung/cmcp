import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {define,str,integer,validator,result} from './schema.mjs';
const CHUNK=1048576, MAX=64*1024*1024*1024;
export const binaryDefinitions=[
  define('mac_binary_info','Get size and SHA-256 of a regular Mac file.',{path:str},['path'],true),
  define('mac_binary_read','Read at most 1 MiB as base64. Prefer mac_download_to_cloud for transfers.',{path:str,offset:integer(0,MAX),length:integer(1,CHUNK)},['path','offset'],true),
  define('mac_binary_begin','Begin atomic binary upload. Requires an existing parent directory; max 64 GiB.',{path:str,size:integer(0,MAX),sha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},overwrite:{type:'boolean'}},['path','size','sha256']),
  define('mac_binary_write','Append a canonical base64 chunk at the exact next offset.',{upload_id:str,offset:integer(0,MAX),data:{type:'string',minLength:4,maxLength:1398104}},['upload_id','offset','data']),
  define('mac_binary_finish','Verify SHA-256 and atomically publish, or cancel an upload.',{upload_id:str,cancel:{type:'boolean'}},['upload_id'])
];
export function createBinaryTools({roots}) {
  const bases=roots.map(r=>fs.realpathSync(r)), uploads=new Map(), validate=validator(binaryDefinitions);
  const inside = file => bases.some(root=> { const rel=path.relative(root,file); return !rel || (rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel)); });
  function allowed(file,writing=false) {
    if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error('Use an absolute Mac path');
    const normalized=path.resolve(file), parent=fs.realpathSync(path.dirname(normalized));
    const resolved=path.join(parent,path.basename(normalized));
    if(!inside(resolved))throw Error('File is outside allowed roots');
    try { const st=fs.lstatSync(resolved); if(!st.isFile()||st.isSymbolicLink())throw Error('Expected a regular file, not a symlink'); }
    catch(e){if(!writing||e.code!=='ENOENT')throw e;}
    return resolved;
  }
  function openRead(file) {
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try {const a=fs.fstatSync(fd),b=fs.lstatSync(file); if(!a.isFile()||a.ino!==b.ino||a.dev!==b.dev||allowed(file)!==file)throw Error('File changed while opening');return fd;}
    catch(e){fs.closeSync(fd);throw e;}
  }
  async function hashFd(fd) {
    const hash=createHash('sha256'), buf=Buffer.alloc(CHUNK); let offset=0,n;
    // Yield between chunks so shutdown and other calls are not starved.
    while((n=fs.readSync(fd,buf,0,buf.length,offset))>0){hash.update(buf.subarray(0,n));offset+=n;await new Promise(setImmediate);}
    return hash.digest('hex');
  }
  function cleanup(id,u){uploads.delete(id);try{fs.closeSync(u.fd);}catch{}try{const st=fs.lstatSync(u.temporary);if(st.isFile()&&!st.isSymbolicLink()&&st.ino===u.st.ino&&st.dev===u.st.dev)fs.unlinkSync(u.temporary);}catch{}}
  const timer=setInterval(()=>{for(const[id,u]of uploads)if(!u.busy&&Date.now()-u.at>10*60000)cleanup(id,u);},60000);timer.unref();
  async function call(name,args){
    validate(name,args);
    if(name==='mac_binary_info'||name==='mac_binary_read'){
      const file=allowed(args.path),fd=openRead(file);
      try{
        const st=fs.fstatSync(fd);
        if(name==='mac_binary_info')return result({path:file,size:st.size,sha256:await hashFd(fd)});
        const buf=Buffer.alloc(args.length??CHUNK),n=fs.readSync(fd,buf,0,buf.length,args.offset);
        return result({offset:args.offset,bytes:n,data:buf.subarray(0,n).toString('base64')});
      }finally{fs.closeSync(fd);}
    }
    if(name==='mac_binary_begin'){
      if(uploads.size>=8)throw Error('Too many uploads');
      const file=allowed(args.path,true);
      if(!args.overwrite&&fs.existsSync(file))throw Error('Destination exists; set overwrite=true');
      const id=randomUUID(),temporary=path.join(path.dirname(file),'.mcp-upload-'+id);
      const fd=fs.openSync(temporary,'wx+',0o600), st=fs.fstatSync(fd);
      uploads.set(id,{fd,temporary,file,st,size:args.size,sha256:args.sha256.toLowerCase(),offset:0,overwrite:args.overwrite===true,at:Date.now(),busy:false});
      return result({upload_id:id,chunk_size:CHUNK});
    }
    const u=uploads.get(args.upload_id);if(!u)throw Error('Unknown or expired upload');if(u.busy)throw Error('Upload is busy');
    u.at=Date.now();
    if(name==='mac_binary_write'){
      const buf=Buffer.from(args.data,'base64');
      if(buf.toString('base64')!==args.data||buf.length>CHUNK||args.offset!==u.offset||u.offset+buf.length>u.size)throw Error('Invalid base64, chunk size or offset');
      let n=0;while(n<buf.length){const written=fs.writeSync(u.fd,buf,n,buf.length-n,u.offset+n);if(!written)throw Error('Short write');n+=written;}
      u.offset+=n;return result({upload_id:args.upload_id,next_offset:u.offset});
    }
    u.busy=true;
    try{
      if(args.cancel)return result({cancelled:true});
      if(u.offset!==u.size||await hashFd(u.fd)!==u.sha256)throw Error('Size or SHA-256 mismatch; upload discarded');
      if(allowed(u.file,true)!==u.file)throw Error('Destination parent changed');
      const st=fs.lstatSync(u.temporary);if(st.isSymbolicLink()||st.ino!==u.st.ino||st.dev!==u.st.dev)throw Error('Upload temporary file changed');
      fs.fsyncSync(u.fd);fs.closeSync(u.fd);u.fd=-1;
      if(u.overwrite)fs.renameSync(u.temporary,u.file);
      else {fs.linkSync(u.temporary,u.file);fs.unlinkSync(u.temporary);}
      return result({path:u.file,size:u.size,sha256:u.sha256});
    }finally{cleanup(args.upload_id,u);}
  }
  return{definitions:binaryDefinitions,owns:name=>binaryDefinitions.some(d=>d.name===name),call,close(){clearInterval(timer);for(const[id,u]of uploads)cleanup(id,u);}};
}
