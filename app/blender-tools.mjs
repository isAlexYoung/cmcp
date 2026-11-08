// Native adapter for the local socket protocol of ahujasid/mcp-for-blender.
// No upstream server, Python environment, network download or listener is started.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const portSchema={type:'integer',minimum:1,maximum:65535,default:9876,description:'Local MCP for Blender add-on port. Leave at 9876 unless changed in Blender. Connections always stay on 127.0.0.1.'};
const tool=(name,description,properties={},required=[],readOnly=true)=>({name,description,
  inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:!readOnly}});
export const blenderInstructions='Blender tools control the currently open Blender on the physical local computer through the MCP for Blender add-on, not Blender on the VPS. Open Blender and start its add-on server (default port 9876). blender_execute_code returns a job_id: poll blender_job_status on THIS SAME MCP connector until finished before continuing. Do not submit another edit while a job is running. A timeout/disconnect after submission does not cancel Python: inspect the scene before deciding whether to retry. Save a .blend file when the user asks for it. Other Blender MCP servers are not required.';
export const blenderToolDefinitions=[
  tool('blender_connection_status','Check the local MCP for Blender add-on. Reports availability or the currently running CMCP Blender job; never starts Blender.',{port:portSchema}),
  tool('blender_get_scene_info','Read the scene in the currently open local Blender. Use before editing. Older add-ons list only the first ten objects; execute Python to inspect more.',{port:portSchema}),
  tool('blender_get_object_info','Read one local Blender object by its exact name.',{port:portSchema,name:{type:'string',minLength:1,maxLength:1024}},['name']),
  tool('blender_execute_code','Run Python in the CURRENT local Blender scene (bpy is available). For modeling, materials, animation, rendering, import/export and saving. Returns a job_id immediately; poll blender_job_status on this same connector. No automatic retries. Does not cancel Blender execution if the connection times out.',{port:portSchema,code:{type:'string',minLength:1,maxLength:200000},timeout_ms:{type:'integer',minimum:1000,maximum:600000,default:120000}},['code'],false),
  tool('blender_job_status','Read a Blender script job on this same MCP connector. Returns running/succeeded/failed/unknown, elapsed time and result. An unknown outcome must be inspected before retrying; jobs cannot be cancelled safely by closing the socket.',{job_id:{type:'string',minLength:1,maxLength:64}},['job_id']),
  tool('blender_get_viewport_screenshot','Return a PNG image of the local Blender 3D viewport. Needs an open 3D View. Uses a temporary local image and removes it after returning.',{port:portSchema,max_size:{type:'integer',minimum:128,maximum:1600,default:800}}),
];
const definitions=new Map(blenderToolDefinitions.map(d=>[d.name,d]));
const textResult=(value,isError=false)=>({...(isError?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(value)}]});
const failure=(code,message,unknown=false)=>Object.assign(Error(message),{code,outcomeUnknown:unknown});
function validate(name,args){
  const def=definitions.get(name);if(!def)throw Error('Unknown Blender tool');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(def.inputSchema.properties,k)))throw Error('Invalid Blender arguments');
  for(const key of def.inputSchema.required)if(!Object.hasOwn(args,key))throw Error('Missing Blender argument: '+key);
  for(const [key,value] of Object.entries(args)){
    const s=def.inputSchema.properties[key];
    if(s.type==='integer'?(!Number.isInteger(value)||value<s.minimum||value>s.maximum):(typeof value!=='string'||value.length<s.minLength||value.length>s.maxLength))throw Error('Invalid Blender argument: '+key);
  }
}

export function createBlenderTools({connectTimeoutMs=2000,readTimeoutMs=10000,maxResponseBytes=8*1024*1024}={}){
  const sockets=new Set(),jobs=new Map(),busy=new Map();let closed=false;
  function request(port,type,params={},timeoutMs=readTimeoutMs){
    return new Promise((resolve,reject)=>{
      if(closed)return reject(failure('CLOSED','CMCP Blender connection is closed.'));
      const socket=net.createConnection({host:'127.0.0.1',port});sockets.add(socket);
      const decoder=new StringDecoder('utf8');let body='',size=0,sent=false,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);sockets.delete(socket);socket.destroy();error?reject(error):resolve(value);};
      const lost=(code,message)=>failure(code,message,sent&&type==='execute_code');
      let timer=setTimeout(()=>finish(lost('BLENDER_CONNECT','Cannot connect to local Blender. Open Blender, enable MCP for Blender and start its server; check the add-on port.')),connectTimeoutMs);
      socket.once('connect',()=>{
        clearTimeout(timer);timer=setTimeout(()=>finish(lost('BLENDER_TIMEOUT','Blender did not reply before the deadline. It may be busy. Closing this connection does not cancel a submitted script. Inspect the scene before retrying.')),timeoutMs);
        sent=true;socket.write(JSON.stringify({type,params}));
      });
      socket.on('data',chunk=>{
        size+=chunk.length;if(size>maxResponseBytes)return finish(lost('BLENDER_RESPONSE_LIMIT','Blender response exceeds the size limit. Print a smaller result and inspect before retrying.'));
        body+=decoder.write(chunk);let reply;
        try{reply=JSON.parse(body);}catch{return;}
        if(!reply||Array.isArray(reply)||!['success','error'].includes(reply.status))return finish(lost('BLENDER_PROTOCOL','Invalid response from the local Blender add-on.'));
        if(reply.status==='error')return finish(failure('BLENDER_ERROR',String(reply.message||'Blender command failed.').slice(0,32768)));
        if(reply.result?.error)return finish(failure('BLENDER_ERROR',String(reply.result.error).slice(0,32768)));
        finish(null,reply.result??{});
      });
      socket.once('error',e=>finish(lost('BLENDER_CONNECTION',e.code==='ECONNREFUSED'?'Local Blender is unavailable. Open Blender, enable MCP for Blender and start its server (default port 9876).':'Local Blender connection was interrupted. Check Blender before retrying.')));
      socket.once('close',()=>finish(lost('BLENDER_DISCONNECTED','Local Blender disconnected without a complete reply. Check the scene before retrying.')));
    });
  }
  function snapshot(job){return {job_id:job.id,port:job.port,state:job.state,elapsed_ms:(job.finished||Date.now())-job.started,
    ...(job.state==='running'?{next:'Poll blender_job_status on this same MCP connector; do not start another edit.'}:{}),
    ...(job.result!==undefined?{result:job.result}:{}),...(job.error?{error:job.error,code:job.code,outcome_unknown:job.state==='unknown'}:{})};}
  function prune(){
    for(const [id,j] of jobs)if(j.finished&&Date.now()-j.finished>60*60*1000)jobs.delete(id);
    while(jobs.size>=32){const old=[...jobs.values()].find(j=>j.finished);if(!old)break;jobs.delete(old.id);}
  }
  async function call(name,args={}){
    validate(name,args);
    if(closed)return textResult({code:'CLOSED',error:'CMCP Blender connection is closed.'},true);
    const port=args.port??9876;
    if(name==='blender_job_status'){
      const job=jobs.get(args.job_id);
      return job?textResult(snapshot(job),['failed','unknown'].includes(job.state)):textResult({code:'BLENDER_JOB_UNKNOWN',error:'Job not found on this connector (or CMCP restarted). Inspect Blender before submitting the same script again.'},true);
    }
    const running=busy.get(port);
    if(running)return textResult({...snapshot(running),code:'BLENDER_BUSY'},name!=='blender_connection_status');
    try{
      if(name==='blender_execute_code'){
        prune();if(busy.size>=4)throw failure('BLENDER_BUSY','Four Blender jobs are already running. Poll their status before starting another.');
        const job={id:randomUUID(),port,state:'running',started:Date.now()};jobs.set(job.id,job);busy.set(port,job);
        // Attach both handlers before returning the job. Never resubmit side effects.
        request(port,'execute_code',{code:args.code},args.timeout_ms??120000).then(result=>{job.state='succeeded';job.result=result;},error=>{job.state=error.outcomeUnknown?'unknown':'failed';job.error=error.message;job.code=error.code;}).finally(()=>{job.finished=Date.now();busy.delete(port);});
        return textResult(snapshot(job));
      }
      if(name==='blender_get_viewport_screenshot'){
        const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-blender-'))),file=path.join(dir,'viewport.png');
        try{
          await request(port,'get_viewport_screenshot',{max_size:args.max_size??800,filepath:file,format:'png'});
          const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024)throw failure('BLENDER_IMAGE','Invalid or oversized Blender screenshot.');
          const image=fs.readFileSync(file);if(!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw failure('BLENDER_IMAGE','Blender did not produce a PNG screenshot.');
          return {content:[{type:'image',mimeType:'image/png',data:image.toString('base64')}]};
        }finally{fs.rmSync(dir,{recursive:true,force:true});}
      }
      // Scene info works with both older blender-mcp and current MCP for Blender.
      const value=await request(port,name==='blender_get_object_info'?'get_object_info':'get_scene_info',name==='blender_get_object_info'?{name:args.name}:{});
      return textResult(name==='blender_connection_status'?{connected:true,host:'127.0.0.1',port,scene:value}:value);
    }catch(error){return textResult({code:error.code||'BLENDER_ERROR',error:error.message,outcome_unknown:error.outcomeUnknown===true},true);}
  }
  return {definitions:blenderToolDefinitions,owns:name=>definitions.has(name),call,
    async close(){closed=true;await Promise.all([...sockets].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();})));}};
}
