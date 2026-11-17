import fs from 'node:fs';

/** Generate the Linux flavor from the reviewed POSIX connector, including transfers.
 * Keep one protocol implementation instead of a second thousand-line Python fork.
 */
export function connectorSource() {
  const source = fs.readFileSync(new URL('../macos/cloudpc-connector.py', import.meta.url), 'utf8');
  if (!source.includes('mac-pc-files') || !source.includes('mac_binary_info')) throw Error('POSIX connector template changed; review Linux adaptation');
  return source.replaceAll('/Users/name/project', '/home/name/project').replaceAll('mac-pc-files', 'linux-pc-files').replaceAll('mac_', 'linux_').replaceAll('Mac', 'local Linux PC');
}
