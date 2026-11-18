import fs from 'node:fs';

/** Generate the Linux flavor from the reviewed POSIX connector, including transfers.
 * Keep one protocol implementation instead of a second thousand-line Python fork.
 */
export function connectorSource() {
  const source = fs.readFileSync(new URL('../macos/cloudpc-connector.py', import.meta.url), 'utf8');
  const {version} = JSON.parse(fs.readFileSync(new URL('../linux/package.json', import.meta.url), 'utf8'));
  const versionLine = /^VERSION = "[0-9.]+"/m;
  const desktopRequirement = '"mac_screenshot": "desktop", ';
  if (!source.includes('mac-pc-files') || !source.includes('mac_binary_info') || !source.includes(desktopRequirement)
      || !versionLine.test(source) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw Error('POSIX connector template changed; review Linux adaptation');
  }
  // Let the same connector work with earlier Linux clients that lack desktop tools.
  return source.replace(desktopRequirement, '')
    .replace(versionLine, 'VERSION = "' + version + '"')
    .replaceAll('/Users/name/project', '/home/name/project')
    .replaceAll('mac-pc-files', 'linux-pc-files')
    .replaceAll('mac_', 'linux_')
    .replaceAll('Mac', 'local Linux PC');
}
