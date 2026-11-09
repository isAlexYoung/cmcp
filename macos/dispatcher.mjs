import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {compatibleToolDefinitions} from './tool-schemas.mjs';
import {createMacTools} from './mac-tools.mjs';
import {createBinaryTools} from './binary-tools.mjs';
import {createBlenderTools,blenderInstructions} from '../app/blender-tools.mjs';
import {createToolRegistry} from '../app/tool-registry.mjs';
import {KIT,VERSION,STATE} from './platform.mjs';
import path from 'node:path';
import fs from 'node:fs';
// Built-in Mac tools and the user's mcp-tools behind one catalog (app/tool-registry.mjs).
export async function createDispatcher({roots,filesystem:injected,stateDir=STATE,registryOptions={}}) {
  const mac=createMacTools({roots}),binary=createBinaryTools({roots}),blender=createBlenderTools();
  let filesystem=injected;
  if(!filesystem){
    const local=path.join(KIT,'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js');
    const transport=new StdioClientTransport({command:process.execPath,args:[fs.existsSync(local)?local:path.join(KIT,'../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'),...roots],stderr:'ignore'});
    filesystem=new Client({name:'cmcp-mac',version:VERSION});await filesystem.connect(transport);
  }
  const files={definitions:compatibleToolDefinitions(await filesystem.listTools()).tools,call:(name,args)=>filesystem.callTool({name,arguments:args},undefined,{timeout:120000})};
  const registry=createToolRegistry({stateDir,providers:[files,mac,binary,blender],serverName:'mac-pc-files',version:VERSION,...registryOptions,
    instructions:{base:`These tools operate on the physical Mac. Use absolute Mac paths, such as /Users/name/project. Allowed file roots: ${JSON.stringify(roots)}. Commands and launched programs run as the current Mac user with full account permissions. The cloud terminal is a separate Linux computer.`,blender:blenderInstructions}});
  return{forward:registry.forward,registry,get definitions(){return registry.list().tools;},async close(){binary.close();await Promise.allSettled([registry.close(),blender.close(),mac.close(),filesystem.close()]);}};
}
