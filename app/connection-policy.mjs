import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCloudcliKinds, CLAUDEWEB } from './cloudcli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const deviceWorkerKey = (directory, id) => hash(path.resolve(directory) + '\0' + id);
export const platformConnector = (platform = process.platform) =>
  platform === 'darwin' ? 'mac-pc-files' : platform === 'linux' ? 'linux-pc-files' : 'windows-pc-files';

export function connectorPolicy(directory, id, primary, dual, platform = process.platform) {
  const key = deviceWorkerKey(directory, id);
  const tag = hash(key).slice(0, 16);
  return { key, name: 'cmcp-pc-' + tag, ssh: 'cmcp-ssh-' + tag, web: platformConnector(platform), primary, dual };
}

/** Send the routing code with the connector source so current ClaudeWeb servers need no upgrade. */
export function managedConnectorSource(source, policy) {
  if (!policy) return source;
  const marker = '# CMCP_MANAGED_CONNECTOR';
  if (!source.includes(marker)) throw Error('Managed connector marker missing');
  const helper = fs.readFileSync(new URL('./managed-connector.py', import.meta.url), 'utf8');
  return source.replace(marker, () => 'MANAGED_POLICY = json.loads(' + JSON.stringify(JSON.stringify(policy)) + ')\n' + helper);
}

/** Apply one CMCP connection policy per device, regardless of the platform's UI. */
export function configureClaudewebTargets(directory, targets, readLogin) {
  const kinds = readCloudcliKinds(directory);
  const direct = new Map(targets.filter(t => t.authMode === 'cloudcli' && !t.tunnel).map(t => [t.name, t]));
  return targets.map(target => {
    if (target.authMode !== 'cloudcli') return target;
    const id = target.tunnel?.id || target.name.slice('cloudcli:'.length);
    let login;
    try { login = readLogin(directory, id); } catch {}
    const url = direct.get('cloudcli:' + id);
    const primary = target.tunnel ? 'ssh' : 'url';
    const dual = Boolean(login?.dualConnection === true && url);
    const policy = connectorPolicy(directory, id, primary, dual);
    const sshRevision=login&&(dual||primary==='ssh')?hash(JSON.stringify(login)):null;
    return { ...target, policy, knownStandalone: kinds[id] === CLAUDEWEB,
      sshAvailable: Boolean(login), fallbackUrl: dual ? url.url : null,
      stamp: JSON.stringify([target.stamp, policy, dual ? url.stamp : null, sshRevision]) };
  });
}
