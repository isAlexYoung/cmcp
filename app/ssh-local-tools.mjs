// Reuse the same platform executors and filesystem server as the web bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {compatibleToolDefinitions} from './tool-schemas.mjs';
import {createBlenderTools,blenderInstructions} from './blender-tools.mjs';
import {createToolRegistry} from './tool-registry.mjs';
import {hostClient,HostedProxy} from './tool-host.mjs';

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
    // Third-party tools run once, in the main CMCP process, when it is there.
    const client=hostClient(directory);
    return createDispatcher({roots,stateDir:directory,registryOptions:{makeProxy:options=>new HostedProxy(options,client)}});
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
    const filesystem={definitions:files.tools,call:(name,args)=>backend.callTool({name,arguments:args},undefined,{timeout:120000})};
    // Third-party tools run once, in the CMCP service, when it is there.
    const client=hostClient(directory);
    const registry=createToolRegistry({stateDir:directory,roots,providers:[filesystem,windows,binary,blender],serverName:'windows-pc-files',makeProxy:options=>new HostedProxy(options,client),version:JSON.parse(fs.readFileSync(path.join(here,'package.json'),'utf8')).version,
      instructions:{base:`These tools operate on the user's physical Windows PC, not the VPS. Allowed file roots: ${JSON.stringify(roots)}. Use absolute Windows paths. Use windows_execute/windows_run_program for local commands and windows_start_process/windows_process_status for background jobs. The cloud CLI's built-in Bash, Read and Edit operate on the VPS; use these MCP tools for local work. Binary files use windows_binary_* tools. Operations run as the local Windows account without automatic elevation.`,blender:blenderInstructions}});
    return {forward:registry.forward,registry,get definitions(){return registry.list().tools;},async close(){binary.close();await Promise.allSettled([registry.close(),blender.close(),windows.close(),backend.close()]);}};
  } catch(error){binary.close();await Promise.allSettled([blender.close(),windows.close(),backend.close()]);throw error;}
}
