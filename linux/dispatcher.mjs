import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {compatibleToolDefinitions} from '../app/tool-schemas.mjs';
import {createToolRegistry} from '../app/tool-registry.mjs';
import {createBlenderTools, blenderInstructions} from '../app/blender-tools.mjs';
import {createLinuxTools, createLinuxBinaryTools} from './tools.mjs';
import {createLinuxDesktopTools} from './desktop-tools.mjs';
import {createLinuxAdminTools} from './admin-tools.mjs';
import {KIT, STATE, VERSION} from './platform.mjs';

export async function createDispatcher({roots, stateDir = STATE, filesystem: injected, registryOptions = {}}) {
  const commands = createLinuxTools({roots}), binary = createLinuxBinaryTools({roots});
  const desktop = createLinuxDesktopTools({roots}), blender = createBlenderTools();
  let filesystem = injected, registry;
  try {
    if (!filesystem) {
      const entry = [path.join(KIT, 'node_modules'), path.join(KIT, '../node_modules')].map(folder => path.join(folder, '@modelcontextprotocol/server-filesystem/dist/index.js')).find(file => fs.existsSync(file));
      if (!entry) throw Error('缺少 CMCP 文件工具依赖，请重新安装。');
      filesystem = new Client({name: 'cmcp-linux', version: VERSION});
      await filesystem.connect(new StdioClientTransport({command: process.execPath, args: [entry, ...roots], stderr: 'ignore'}));
    }
    const files = {definitions: compatibleToolDefinitions(await filesystem.listTools()).tools, call: (name, args) => filesystem.callTool({name, arguments: args}, undefined, {timeout: 120000})};
    const admin = createLinuxAdminTools({stateDir});
    registry = createToolRegistry({stateDir, roots, providers: [files, commands, binary, desktop, blender, admin], serverName: 'linux-pc-files', version: VERSION, platform: 'linux', ...registryOptions,
      instructions: {base: `These tools operate on the user's physical Linux PC, NOT the cloud/VPS. Use absolute local Linux paths such as /home/name/project. Allowed file roots: ${JSON.stringify(roots)}. Use linux_execute/linux_run_program for local commands, linux_start_process/linux_process_status for local jobs, linux_binary_* for binary transfers, and linux_screenshot/linux_desktop_action for the local X11 desktop. The cloud terminal and its built-in Bash, Read and Edit act on the REMOTE VPS even though both systems run Linux. Local commands run as the current desktop user without automatic elevation.`, blender: blenderInstructions}});
    return {forward: registry.forward, registry, get definitions() { return registry.list().tools; }, async close() { binary.close(); await Promise.allSettled([registry.close(), commands.close(), blender.close(), filesystem.close()]); }};
  } catch (error) {
    binary.close(); await Promise.allSettled([commands.close(), blender.close(), filesystem?.close(), registry?.close()]); throw error;
  }
}
