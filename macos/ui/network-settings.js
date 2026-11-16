// Shared by the settings form and the Mac backend; contains no platform APIs.
export function proxySettings(value={}) {
  const proxyMode=value.proxyMode??'auto',proxyHost=value.proxyHost??'127.0.0.1',proxyPort=value.proxyPort??7890;
  if(!['auto','manual','direct'].includes(proxyMode)||typeof proxyHost!=='string'||!proxyHost.trim()||proxyHost.length>253||/[\s/@?#\\]/.test(proxyHost)||!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535)throw Object.assign(Error('请填写有效的代理主机和 1–65535 的端口。'),{code:'CMCP_PROXY_SETTINGS'});
  const host=proxyHost.includes(':')&&!proxyHost.startsWith('[')?`[${proxyHost}]`:proxyHost;
  let address;try{address=new URL(`http://${host}:${proxyPort}`);}catch{throw Object.assign(Error('请填写有效的代理主机和 1–65535 的端口。'),{code:'CMCP_PROXY_SETTINGS'});}
  if(!address.hostname||address.username||address.password||address.pathname!=='/')throw Object.assign(Error('请填写有效的代理主机和 1–65535 的端口。'),{code:'CMCP_PROXY_SETTINGS'});
  return {proxyMode,proxyHost,proxyPort};
}
export function proxyAddress(value){const settings=proxySettings(value),host=settings.proxyHost;return settings.proxyMode==='manual'?new URL(`http://${host.includes(':')&&!host.startsWith('[')?`[${host}]`:host}:${settings.proxyPort}`).origin:'';}
export function proxyKey(value){const settings=proxySettings(value);return JSON.stringify(settings.proxyMode==='manual'?[settings.proxyMode,settings.proxyHost,settings.proxyPort]:[settings.proxyMode]);}
