import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {compatibleToolDefinitions} from './tool-schemas.mjs';
import {createMacTools} from './mac-tools.mjs';
import {createBinaryTools} from './binary-tools.mjs';
import {KIT,VERSION} from './platform.mjs';
import path from 'node:path';
import fs from 'node:fs';
export async function createDispatcher({roots,filesystem:injected}) {
  const mac=createMacTools({roots}),binary=createBinaryTools({roots});
  let filesystem=injected;
  if(!filesystem){
    const local=path.join(KIT,'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js');
    const transport=new StdioClientTransport({command:process.execPath,args:[fs.existsSync(local)?local:path.join(KIT,'../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'),...roots],stderr:'ignore'});
    filesystem=new Client({name:'cmcp-mac',version:VERSION});await filesystem.connect(transport);
  }
  let definitions=compatibleToolDefinitions(await filesystem.listTools()).tools;
  definitions=[...definitions,...mac.definitions,...binary.definitions];
  const names=new Set(definitions.map(d=>d.name));let active=0;
  async function forward(msg){
    const id=msg?.id??null;
    const error=(code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
    if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||(id!==null&&typeof id!=='string'&&typeof id!=='number'))return error(-32600,'Invalid JSON-RPC request');
    if(!Object.hasOwn(msg,'id'))return null;
    let value;
    if(msg.method==='initialize')value={protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(msg.params?.protocolVersion)?msg.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'mac-pc-files',version:VERSION},instructions:`These tools operate on the physical Mac. Use absolute Mac paths, such as /Users/name/project. Allowed file roots: ${JSON.stringify(roots)}. Commands and launched programs run as the current Mac user with full account permissions. The cloud terminal is a separate Linux computer.`};
    else if(msg.method==='ping')value={};
    else if(msg.method==='tools/list')value={tools:definitions};
    else if(msg.method==='tools/call'){
      const p=msg.params;if(!p||typeof p.name!=='string'||!names.has(p.name))return error(-32602,'Unknown tool');
      if(active>=16)return error(-32000,'Too many active requests');
      const args=p.arguments??{};if(!args||typeof args!=='object'||Array.isArray(args))return error(-32602,'Arguments must be an object');
      active++;
      try{value=mac.owns(p.name)?await mac.call(p.name,args):binary.owns(p.name)?await binary.call(p.name,args):await filesystem.callTool({name:p.name,arguments:args},undefined,{timeout:120000});}
      catch(e){value={isError:true,content:[{type:'text',text:e.message}]};}
      finally{active--;}
    }else return error(-32601,'Method not found');
    return{jsonrpc:'2.0',id,result:value};
  }
  return{forward,definitions,async close(){binary.close();await Promise.allSettled([mac.close(),filesystem.close()]);}};
}
