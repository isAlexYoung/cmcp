// Linux tools reuse the POSIX process supervisor and binary-transfer engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMacTools, macDefinitions} from '../macos/mac-tools.mjs';
import {createBinaryTools} from '../macos/binary-tools.mjs';
import {executable} from './platform.mjs';
import {define, integer, result, str, validator} from '../macos/schema.mjs';

const cwd = {type: 'string', minLength: 1};
const environment = {type: 'object', additionalProperties: {type: 'string'}, description: 'Environment overrides for this process.'};
const outputLimit = integer(1000, 200000);
const timeout = integer(100, 120000);
const shell = {enum: ['bash']};
const text = {type: 'string', maxLength: 200000};
const argsList = {type: 'array', items: {type: 'string', maxLength: 32768}, maxItems: 500};
const execution = {cwd, env: environment, timeout_ms: timeout, output_limit: outputLimit};
const systemTools = ['git', 'python3', 'python', 'pip', 'node', 'npm', 'gcc', 'g++', 'clang', 'clang++', 'cmake', 'ninja',
  'make', 'java', 'javac', 'gradle', 'adb', 'emulator', 'sdkmanager', 'avdmanager', 'docker', 'podman', 'apt', 'snap',
  'flatpak', 'cargo', 'rustc', 'go', 'uv', 'curl'];

function rename(definition) {
  return {...definition, name: definition.name.replace(/^mac_/, 'linux_'), description: definition.description.replace(/\bMac\b/g, 'local Linux PC').replace(/mac_/g, 'linux_')};
}
export function createLinuxTools({roots}) {
  const source = createMacTools({roots, platform: 'linux', definitions: sharedDefinitions});
  return {definitions, owns: name => definitions.some(tool => tool.name === name), call(name, args) {
    if (!name.startsWith('linux_')) throw Error('Unknown Linux tool');
    if (name === 'linux_toolchain_info') { validateExtra(name, args); return toolchainInfo(); }
    if (name === 'linux_adb' || name === 'linux_adb_devices') {
      validateExtra(name, args);
      const program = androidExecutable('adb');
      if (!program) throw Error('Android adb was not found on the Linux PC');
      if (name === 'linux_adb_devices') return source.call('mac_run_program', {program, args: ['devices', '-l']});
      const {serial, args: argv = [], ...options} = args;
      return source.call('mac_run_program', {...options, program, args: serial ? ['-s', serial, ...argv] : argv});
    }
    if (name === 'linux_process_input') {
      validateExtra(name, args);
      return source.call('mac_process_stdin', {session_id: args.session_id, data: args.text ?? '', close: args.close_stdin === true});
    }
    if (name === 'linux_execute') return source.call('mac_execute', {shell: 'bash', ...args});
    return source.call(name.replace(/^linux_/, 'mac_'), args);
  }, close: () => source.close()};
}

const inherited = macDefinitions.filter(tool => ['mac_system_info', 'mac_list_processes', 'mac_stop_process'].includes(tool.name)).map(rename);
const runProgram = define('linux_run_program', 'Run a program directly on the Linux PC with an argument array; program and executable are equivalent argument names.', {
  program: str, executable: str, args: argsList, ...execution,
});
runProgram.inputSchema.oneOf = [{required: ['program']}, {required: ['executable']}];
const startProcess = define('linux_start_process', 'Start a managed Linux background program or a Bash command. Returns a session ID for output, input and stop operations.', {
  command: {...text, minLength: 1}, shell, program: str, args: argsList, cwd, env: environment, timeout_ms: integer(0, 86400000),
});
startProcess.inputSchema.oneOf = [
  {required: ['program'], not: {required: ['shell']}},
  {required: ['command'], not: {required: ['args']}},
];
const execute = define('linux_execute', 'Execute Bash on the physical Linux PC with the current desktop user’s permissions. Returns stdout, stderr and exit code.', {
  command: {...text, minLength: 1}, shell, ...execution,
}, ['command']);
const supportedBySupervisor = [
  ...inherited, execute, runProgram, startProcess,
  define('linux_list_sessions', 'List managed background sessions and their state. Use linux_process_status to read output.', {}, [], true),
  define('linux_process_status', 'Read a Linux background session. Optional offsets count decoded characters; a wait can return after the process finishes.', {
    session_id: str, stdout_offset: integer(0, Number.MAX_SAFE_INTEGER), stderr_offset: integer(0, Number.MAX_SAFE_INTEGER),
    wait_ms: integer(0, 30000), output_limit: outputLimit,
  }, ['session_id'], true),
  define('linux_process_stdin', 'Write text to the stdin pipe of a managed Linux process.', {
    session_id: str, data: text, close: {type: 'boolean'},
  }, ['session_id']),
];
const extras = [
  define('linux_process_input', 'Write text to a managed Linux process and optionally close its stdin pipe.', {
    session_id: str, text, close_stdin: {type: 'boolean'},
  }, ['session_id']),
  define('linux_toolchain_info', 'Find local compilers, build tools, runtimes, containers and Android SDK executables.', {}, [], true),
  define('linux_adb_devices', 'List Android devices and emulators visible to the Linux PC’s adb.', {}, [], true),
  define('linux_adb', 'Run adb on the local Linux PC. Use linux_adb_devices to find a device serial when needed.', {
    args: {type: 'array', items: {type: 'string', maxLength: 32768}, maxItems: 256},
    serial: {type: 'string', minLength: 1, maxLength: 256}, cwd, timeout_ms: timeout, output_limit: outputLimit,
  }),
];
const definitions = [...supportedBySupervisor, ...extras];
const sharedDefinitions = supportedBySupervisor.map(tool => ({...tool, name: tool.name.replace(/^linux_/, 'mac_')}));
const validateExtra = validator(extras);

function androidSdk() {
  return [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Android', 'Sdk')]
    .filter(Boolean).find(directory => {
      try { return path.isAbsolute(directory) && fs.statSync(directory).isDirectory(); }
      catch { return false; }
    }) ?? null;
}

function androidExecutable(name, sdk = androidSdk()) {
  const folder = {adb: 'platform-tools', emulator: 'emulator', sdkmanager: 'cmdline-tools/latest/bin', avdmanager: 'cmdline-tools/latest/bin'}[name];
  return executable(name) || (sdk && executable(name, {PATH: path.join(sdk, folder)}));
}

function toolchainInfo() {
  const sdk = androidSdk();
  const android = new Set(['adb', 'emulator', 'sdkmanager', 'avdmanager']);
  const paths = Object.fromEntries(systemTools.map(name => [name, android.has(name) ? androidExecutable(name, sdk) : executable(name)]));
  return result({...paths, tools: paths, android_sdk: sdk, environment: {PATH: process.env.PATH ?? '', JAVA_HOME: process.env.JAVA_HOME ?? null}});
}
export function createLinuxBinaryTools({roots}) {
  const source = createBinaryTools({roots}), definitions = source.definitions.map(rename), names = new Set(definitions.map(item => item.name));
  return {definitions, owns: name => names.has(name), call(name, args) {
    if (!names.has(name)) throw Error('Unknown Linux binary tool');
    return source.call(name.replace(/^linux_/, 'mac_'), args);
  }, close: () => source.close()};
}
