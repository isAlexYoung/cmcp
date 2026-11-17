import {receive, downloadUpdate as downloadShared} from '../macos/updates.mjs';

const repository = 'https://github.com/isAlexYoung/cmcp';
export function selectRelease(release, current, arch) {
  const version = value => {
    if (typeof value !== 'string' || !/^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value)) throw Error('Invalid stable version');
    return value.replace(/^v/, '').split('.').map(Number);
  };
  if (arch !== 'x64' || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw Error('Invalid Linux release');
  const next = version(release.tag_name), old = version(current);
  let comparison = 0;
  for (let i = 0; i < 3 && !comparison; i++) comparison = next[i] - old[i];
  if (comparison <= 0) return null;
  const number = next.join('.'), name = `CMCP-${number}-linux-x64.zip`;
  const pick = name => {
    const matches = release.assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || matches[0].browser_download_url !== `${repository}/releases/download/${release.tag_name}/${name}`) throw Error('没有适用的 Linux 更新包');
    return matches[0];
  };
  const zip = pick(name), checksum = pick(name + '.sha256');
  if (!Number.isSafeInteger(zip.size) || zip.size < 1 || zip.size > 268435456 || !Number.isSafeInteger(checksum.size) || checksum.size < 1 || checksum.size > 1024) throw Error('Invalid asset size');
  return {version: number, name, zip, checksum};
}
export async function checkRelease(current, arch, proxy = '', fetch = receive) {
  return selectRelease(JSON.parse((await fetch('https://api.github.com/repos/isAlexYoung/cmcp/releases/latest', {proxy})).toString('utf8')), current, arch);
}
export const downloadUpdate = options => downloadShared({...options, releaseFor: checkRelease});
