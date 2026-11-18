import {receive, downloadUpdate as downloadShared} from '../macos/updates.mjs';

const repository = 'https://github.com/isAlexYoung/cmcp';
const stableVersion = /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const pageSize = 30;
function version(value) {
  if (typeof value !== 'string' || !stableVersion.test(value)) throw Error('Invalid stable version');
  return value.replace(/^v/, '').split('.').map(Number);
}
function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function selectRelease(release, current, arch) {
  if (arch !== 'x64' || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw Error('Invalid Linux release');
  const next = version(release.tag_name), old = version(current);
  if (compare(next, old) <= 0) return null;
  const number = next.join('.'), name = `CMCP-${number}-linux-x64.zip`;
  const matches = filename => release.assets.filter(asset => asset?.name === filename);
  const packages = matches(name), checksums = matches(name + '.sha256');
  if (!packages.length && !checksums.length) return null;
  const pick = (matches, filename) => {
    if (matches.length !== 1 || matches[0].browser_download_url !== `${repository}/releases/download/${release.tag_name}/${filename}`) throw Error('Linux 更新包或校验文件无效');
    return matches[0];
  };
  const zip = pick(packages, name), checksum = pick(checksums, name + '.sha256');
  if (!Number.isSafeInteger(zip.size) || zip.size < 1 || zip.size > 268435456 || !Number.isSafeInteger(checksum.size) || checksum.size < 1 || checksum.size > 1024) throw Error('Invalid asset size');
  return {version: number, name, zip, checksum};
}
export async function checkRelease(current, arch, proxy = '', fetch = receive) {
  if (arch !== 'x64') throw Error('Invalid Linux architecture');
  const installed = version(current), candidates = [];
  // Releases are paginated and are not necessarily in semantic version order.
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.github.com/repos/isAlexYoung/cmcp/releases?per_page=${pageSize}&page=${page}`;
    const releases = JSON.parse((await fetch(url, {proxy})).toString('utf8'));
    if (!Array.isArray(releases) || releases.length > pageSize) throw Error('Invalid release list');
    for (const release of releases) {
      if (!release || typeof release !== 'object' || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean' || typeof release.tag_name !== 'string') throw Error('Invalid release metadata');
      if (release.draft || release.prerelease || !stableVersion.test(release.tag_name)) continue;
      const number = version(release.tag_name);
      if (compare(number, installed) > 0) candidates.push({number, release});
    }
    if (releases.length < pageSize) {
      candidates.sort((a, b) => compare(b.number, a.number));
      for (const {release} of candidates) {
        const update = selectRelease(release, current, arch);
        if (update) return update;
      }
      return null;
    }
  }
  throw Error('Release list exceeded page limit');
}
export const downloadUpdate = options => downloadShared({...options, releaseFor: checkRelease});
