// Reuse the existing POSIX process supervisor and bounded binary-transfer engine.
// Native desktop tools are deliberately absent until the X11 milestone is tested.
import {createMacTools} from '../macos/mac-tools.mjs';
import {createBinaryTools} from '../macos/binary-tools.mjs';
import {executable} from './platform.mjs';
import {result} from '../macos/schema.mjs';

function rename(definition) {
  return {...definition, name: definition.name.replace(/^mac_/, 'linux_'), description: definition.description.replace(/\bMac\b/g, 'local Linux PC').replace(/mac_/g, 'linux_')};
}
export function createLinuxTools({roots}) {
  const source = createMacTools({roots, platform: 'linux'});
  const definitions = source.definitions.filter(item => !['mac_open_url', 'mac_open_path', 'mac_screenshot', 'mac_keyboard', 'mac_desktop_action'].includes(item.name)).map(rename);
  const execute = definitions.find(item => item.name === 'linux_execute');
  execute.inputSchema = {...execute.inputSchema, properties: {...execute.inputSchema.properties, shell: {enum: ['bash']}}};
  const names = new Set(definitions.map(item => item.name));
  return {definitions, owns: name => names.has(name), call(name, args) {
    if (!names.has(name)) throw Error('Unknown Linux tool');
    if (name === 'linux_toolchain_info') return result(Object.fromEntries(['git', 'python3', 'node', 'npm', 'gcc', 'g++', 'clang', 'cmake', 'make', 'java', 'adb'].map(tool => [tool, executable(tool)])));
    if (name === 'linux_execute' && args.shell !== undefined && args.shell !== 'bash') throw Error('Use bash on this Linux PC');
    return source.call(name.replace(/^linux_/, 'mac_'), name === 'linux_execute' ? {...args, shell: 'bash'} : args);
  }, close: () => source.close()};
}
export function createLinuxBinaryTools({roots}) {
  const source = createBinaryTools({roots}), definitions = source.definitions.map(rename), names = new Set(definitions.map(item => item.name));
  return {definitions, owns: name => names.has(name), call(name, args) {
    if (!names.has(name)) throw Error('Unknown Linux binary tool');
    return source.call(name.replace(/^linux_/, 'mac_'), args);
  }, close: () => source.close()};
}
