// Reuse the same platform executors and filesystem server as the web bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {compatibleToolDefinitions} from './tool-schemas.mjs';
import {createBlenderTools,blenderInstructions} from './blender-tools.mjs';

export function sshRoots(directory,platform=process.platform) {
  try {
    const config=JSON.parse(fs.readFileSync(path.join(directory,platform==='darwin'?'targets.json':'config.json'),'utf8').replace(/^\uFEFF/,''));
    if(!Array.isArray(config.roots)||!config.roots.length||config.roots.some(root=>typeof root!=='string'||!path.isAbsolute(root)))throw Error('Invalid local file roots');
    return config.roots;
  } catch(error){if(error.code!=='ENOENT')throw error;}
  if(platform==='win32')return Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+':\\').filter(root=>fs.existsSync(root));
  return [os.homedir()];
}

export async function createSshDispatcher(directory) {
  const roots=sshRoots(directory);
  if(process.platform==='darwin') {
    const {createDispatcher}=await import('../macos/dispatcher.mjs');
    return createDispatcher({roots});
  }
  if(process.platform!=='win32')throw Error('Unsupported local operating system');
  const {createWindowsTools}=await import('./windows-tools.mjs');
  const {createBinaryTools}=await import('./binary-tools.mjs');
  const here=path.dirname(fileURLToPath(import.meta.url));
  const windows=createWindowsTools({defaultCwd:os.homedir(),roots,stateDir:directory}),binary=createBinaryTools({roots}),blender=createBlenderTools();
  const backend=new Client({name:'cmcp-ssh-filesystem',version:'1.0.0'});
  try {
    await backend.connect(new StdioClientTransport({command:process.execPath,args:[path.join(here,'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'),...roots],stderr:'ignore'}));
    const files=compatibleToolDefinitions(await backend.listTools());
    const definitions=[...files.tools,...windows.definitions,...binary.definitions,...blender.definitions];
    const names=new Set(definitions.map(tool=>tool.name));let active=0;
    const forward=async msg=>{
      const id=msg?.id??null,error=(code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
      if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string')return error(-32600,'Invalid request');
      if(!Object.hasOwn(msg,'id'))return null;
      let result;
      if(msg.method==='initialize')result={protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(msg.params?.protocolVersion)?msg.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'windows-pc-files',version:JSON.parse(fs.readFileSync(path.join(here,'package.json'),'utf8')).version},
        instructions:`These tools operate on the user's physical Windows PC, not the VPS. Allowed file roots: ${JSON.stringify(roots)}. Use absolute Windows paths. Use windows_execute/windows_run_program for local commands and windows_start_process/windows_process_status for background jobs. The cloud CLI's built-in Bash, Read and Edit operate on the VPS; use these MCP tools for local work. Binary files use windows_binary_* tools. Operations run as the local Windows account without automatic elevation.`};
      else if(msg.method==='ping')result={};
      else if(msg.method==='tools/list')result={tools:definitions};
      else if(msg.method==='tools/call'){
        const p=msg.params;if(!p||!names.has(p.name)||p.arguments!==undefined&&(!p.arguments||typeof p.arguments!=='object'||Array.isArray(p.arguments)))return error(-32602,'Invalid tool');
        if(active>=16)return error(-32000,'Too many requests');active++;
        try {result=blender.owns(p.name)?await blender.call(p.name,p.arguments??{}):binary.owns(p.name)?await binary.call(p.name,p.arguments??{}):windows.owns(p.name)?await windows.call(p.name,p.arguments??{}):await backend.callTool(p,undefined,{timeout:120000});}
        catch {result={isError:true,content:[{type:'text',text:'Local tool failed; check the operation status before retrying.'}]};}
        finally{active--;}
      } else return error(-32601,'Method not found');
      if(msg.method==='initialize')result.instructions+=' '+blenderInstructions;
      return {jsonrpc:'2.0',id,result};
    };
    return {forward,definitions,async close(){binary.close();await Promise.allSettled([blender.close(),windows.close(),backend.close()]);}};
  } catch(error){binary.close();await Promise.allSettled([blender.close(),windows.close(),backend.close()]);throw error;}
}
