import {agentFor, startLink} from './link-client.mjs';
import {requiresSharedSession} from './desktop-auth.mjs';
import {createSharedSessionGateway} from './shared-session-gateway.mjs';
import {Cloud} from './cloud-connector.mjs';
import {supportsDirectBrowser,createDirectBrowser} from './direct-browser.mjs';
import {connectionDetail} from './connection-transport.mjs';
import {discoverCloudcli,createLaunchPage,cloudcliDevice,cloudcliName,SELF_HOSTED,WEBDESKTOP,CLAUDEWEB} from './cloudcli.mjs';
import {requestBuffered} from './desktop-auth.mjs';
import {startClaudewebMcp} from './claudeweb-mcp.mjs';
import {startSshMcp} from './ssh-mcp.mjs';

// Fixed texts, so the Windows card may show them as they are (Manager.cs PreparationDetail).
export const SELF_HOSTED_READY='自行安装的 CloudCLI：网页可以打开。网址不支持 MCP 时，请选择 SSH。';
export const SELF_HOSTED_DOWN='自行安装的 CloudCLI 暂时无法访问，正在重试。';
export const CLAUDEWEB_READY='ClaudeWeb 独立版：网页可以打开。网址不支持 MCP 时，请选择 SSH。';
export const CLAUDEWEB_DOWN='ClaudeWeb 独立版暂时无法访问，正在重试。';
export const CLAUDEWEB_PASSWORD='ClaudeWeb 独立版：保存的密码无法自动登录，请在网页输入密码，或在 CMCP 中修改密码。';
export const CLAUDEWEB_LOCKED='ClaudeWeb 独立版：密码错误次数过多，登录暂时受限，请稍后重试。';

// Standalone ClaudeWeb: the saved password becomes a one-time code (POST /api/auth/cmcp/code, under
// ClaudeWeb's own per-IP lockout). Returns the code, or the fixed text that says why there is none.
export async function claudewebCode({url,agent,password,signal}){
  const r=await requestBuffered(new URL('/api/auth/cmcp/code',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password}),agent,signal,timeout:15000,limit:16384});
  let v;try{v=JSON.parse(r.body);}catch{}
  if(r.status===200&&typeof v?.code==='string'&&/^[A-Za-z0-9_-]{20,200}$/.test(v.code))return {code:v.code};
  return {issue:v?.error?.code==='AUTH_LOCKED'?CLAUDEWEB_LOCKED:CLAUDEWEB_PASSWORD};
}

// The production target factory is also exercised against independent local
// HTTP/WebSocket desktops. Each target owns its agent, gateway and setup lease.
export function managedTargetFactory({proxyFor, machine, version, forward, catalog, askPassword, notify, log, deviceName, recoveryOptions, healthOptions,
  openTunnel, sshOptions, stopStandaloneSsh, startSshBridge=startSshMcp, startWebBridge=startClaudewebMcp,
  passwordFor, session = false, onReplaced, onCloudcliKind = () => {}, selfHostedProbeMs = 15000, install = (t, auth, agent, signal, preparation) => new Cloud(t.url, auth, agent, signal,preparation).install()}) {
  return async (t, {signal, current, status}) => {
    const record = {name:t.name, url:t.url, installed:null, installing:false, retryAt:0, auth:null,connected:false,connectionEpoch:0};
    const preparationCache={};
    const policy=t.policy, device=cloudcliDevice(t.name);
    const sshController=new AbortController();
    let sshState, webState, sshTask, tunnelFailed=false;
    const confirmStandaloneOverSsh=async()=>{
      if (t.knownStandalone) return true;
      if (policy?.primary!=='url' || !openTunnel || !device) return false;
      let probeTunnel, agent;
      try {
        probeTunnel=await openTunnel({tunnel:{id:device,app:'cloudcli'}},signal);
        agent=agentFor(probeTunnel.cloudcli,'');
        return (await discoverCloudcli(probeTunnel.cloudcli,agent,signal)).kind===CLAUDEWEB;
      } catch { return false; }
      finally { agent?.destroy(); await probeTunnel?.close(); }
    };
    const publishChannels=()=>{
      if (!current() || signal.aborted) return;
      const sshLabel={ready:'已连接',recovering:'正在恢复',connecting:'连接中',failed:'连接异常'};
      const webLabel={connected:'已连接',connecting:'连接中','config-error':'连接异常'};
      const ready=sshState==='ready'||webState==='connected';
      const pending=['connecting','recovering'].includes(sshState)||webState==='connecting';
      const parts=[];
      if (policy.primary==='url'||policy.dual) parts.push('网址 MCP：'+(webLabel[webState]||'不可用'));
      if (policy.primary==='ssh'||policy.dual) parts.push('SSH MCP：'+(sshLabel[sshState]||'不可用'));
      if (tunnelFailed) parts.push('网页 SSH 隧道不可用');
      status.set(t.name,ready?'connected':pending?'connecting':'config-error',parts.join(' · '));
    };
    const startSsh=()=>{
      if (sshTask || !policy || !t.sshAvailable || !sshOptions) return;
      sshTask=Promise.resolve().then(()=>{
        signal.throwIfAborted();
        return startSshBridge({...sshOptions(device),key:policy.key,policy,device,catalog:catalog.list(device),changes:catalog,
          forward,signal:AbortSignal.any([signal,sshController.signal]),status:state=>{sshState=state;publishChannels();}});
      }).catch(()=>{sshState='failed';publishChannels();});
    };
    // Soft probe failures must not revoke setup leases or discard confirmed config.
    let unstable=false,confirmed;
    const publish=(name,state,message)=>{
      const issue=record.tunnel?.getIssue();if(issue){status.set(name,issue.state,issue.message);return;}
      confirmed={name,state,message};
      const soft=unstable&&['connected','configuring'].includes(state);
      status.set(name,soft?'unstable':state,soft?'连接短暂波动，正在探测恢复':message);
    };
    let closed = false;
    let stopping;
    record.stop = () => {
      if (closed) return stopping;
      closed = true;
      sshController.abort();
      stopping = (async () => {
        await record.link?.stop();
        await record.gateway?.close();
        await record.tunnel?.close();
        await sshTask;
        record.backupAgent?.destroy();
        record.agent?.destroy();
        record.cloudcliAgent?.destroy();
      })();
      return stopping;
    };
    signal.addEventListener('abort', record.stop, {once:true});
    try {
      signal.throwIfAborted();
      if (policy && t.sshAvailable) await stopStandaloneSsh?.(device);
      signal.throwIfAborted();
      if (policy?.dual && t.knownStandalone) startSsh();
      if(t.tunnel){
        if(!openTunnel)throw Error('SSH tunnel is unavailable');
        try {
          record.tunnel=await openTunnel(t,signal);
          t={...t,url:record.tunnel[t.tunnel.app]};
        } catch(error) {
          if(!policy?.dual || signal.aborted) throw error;
          tunnelFailed=true;
          t={...t,url:t.fallbackUrl};
        }
        record.url=t.url;
      }
      publish(t.name, 'connecting', '正在检查登录协议（不会提交密码）');
      let proxy='', directUnavailable=false;
      try { if (!record.tunnel) proxy=await proxyFor(t.url, signal); }
      catch(error) {
        if (!policy?.dual || signal.aborted || !await confirmStandaloneOverSsh()) throw error;
        directUnavailable=true;
      }
      signal.throwIfAborted();
      record.agent = agentFor(t.url, proxy);
      const cloudcli=t.authMode==='cloudcli';
      if(cloudcli){
        // No WebDesktop sign-in and no web MCP: the page opens through a local entrance and the
        // device's SSH background channel carries the local tools. A self-hosted CloudCLI keeps its
        // own login; standalone ClaudeWeb is signed in with a one-time code when auto login is on.
        const openPage=async(kind,webMcp=false)=>{
          const claudeweb=kind===CLAUDEWEB,ready=claudeweb?CLAUDEWEB_READY:SELF_HOSTED_READY,down=claudeweb?CLAUDEWEB_DOWN:SELF_HOSTED_DOWN;
          if(device)try{onCloudcliKind(device,kind);}catch{}
          let up=true,issue=null,bridgeState=null;
          const reportChannels=policy&&(policy.primary==='ssh'||webMcp||policy.dual&&claudeweb);
          if (policy?.primary==='ssh' || (policy?.dual && claudeweb)) startSsh();
          const useWeb=!directUnavailable&&claudeweb&&webMcp&&(!policy||policy.primary==='url'||policy.dual);
          const useBackup=policy?.primary==='ssh';
          if(useWeb){
            const url=useBackup?t.fallbackUrl:t.url;
            const name=useBackup?cloudcliName(device):t.name;
            try {
              const agent=useBackup?(record.backupAgent=agentFor(url,await proxyFor(url,signal))):record.agent;
              signal.throwIfAborted();
              webState='connecting';
              record.link=startWebBridge({url,agent,passwordFor:()=>passwordFor(name,signal),machine,catalog,forward,signal,device:device||'',policy,
                status:(state,message)=>{bridgeState={state,message};webState=state;if(policy)publishChannels();else if(current()&&!signal.aborted)publish(t.name,state,message);}});
            } catch(error) {
              if (!policy?.dual || signal.aborted) throw error;
              webState='config-error';
            }
          }
          const signIn=claudeweb&&t.autoLogin===true?async()=>{
            if(!current()||signal.aborted)return null;
            if (directUnavailable || (tunnelFailed && !record.link)) return null;
            if(record.link&&useWeb&&(!useBackup||tunnelFailed)){try{return await record.link.browserCode();}catch{return null;}}
            let password;try{password=await passwordFor(t.name,signal);}catch{}
            if(typeof password!=='string'||!password){issue=CLAUDEWEB_PASSWORD;}
            else{
              try{const result=await claudewebCode({url:t.url,agent:record.agent,password,signal});issue=result.issue||null;if(result.code){publish(t.name,'connected',ready);return result.code;}}
              catch{issue=null;}
              finally{password=undefined;}
            }
            if(issue){log(`[${t.name}] claudeweb-sign-in ${issue===CLAUDEWEB_LOCKED?'locked':'refused'}`);if(current()&&!signal.aborted)publish(t.name,'connected',issue);}
            return null;
          }:undefined;
          record.selfHosted=true;record.claudeweb=claudeweb;record.gateway=await createLaunchPage({url:t.url,signIn});
          if(!current()){await record.gateway.close();throw Error('Target stopped');}
          if(reportChannels)publishChannels();else if(!webMcp)publish(t.name,'connected',ready);
          const probe=setInterval(async()=>{
            if(!current()||signal.aborted||directUnavailable)return;
            try{const r=await requestBuffered(new URL('/',t.url),{agent:record.agent,signal,timeout:10000,limit:262144});up=r.status<500;}catch{up=false;}
            if(reportChannels)publishChannels();
            else if(current()&&!signal.aborted)publish(t.name,up?(bridgeState?.state||'connected'):'offline',up?(bridgeState?.message||issue||ready):down);
          },selfHostedProbeMs);probe.unref?.();
          signal.addEventListener('abort',()=>clearInterval(probe),{once:true});
          return record;
        };
        if (directUnavailable) return await openPage(CLAUDEWEB,true);
        let discovered;
        try{discovered=await discoverCloudcli(t.url,record.agent,signal);}
        catch(error){
          if(policy?.dual&&!signal.aborted&&!error.selfHosted&&await confirmStandaloneOverSsh())return await openPage(CLAUDEWEB,true);
          if(!error.selfHosted||tunnelFailed)throw error;
          return await openPage(SELF_HOSTED);
        }
        if(discovered.kind===CLAUDEWEB)return await openPage(CLAUDEWEB,discovered.webMcp===true);
        if(tunnelFailed)throw Error('SSH tunnel is unavailable');
        {const device=cloudcliDevice(t.name);if(device)try{onCloudcliKind(device,WEBDESKTOP);}catch{}}
        record.cloudcliAgent=record.agent;record.url=record.tunnel?.web||discovered.desktopOrigin;
        record.agent=agentFor(record.url,record.tunnel?'':await proxyFor(record.url,signal));
      }
      const shared = cloudcli || t.authMode === 'shared-browser' || await requiresSharedSession(t.url, record.agent, signal);
      signal.throwIfAborted();
      if (!current()) throw Error('Target stopped');
      if (shared) {
        const gateway = cloudcli || await supportsDirectBrowser(t.url,record.agent,signal) ? createDirectBrowser : createSharedSessionGateway;
        record.gateway = await gateway({name:t.name, baseUrl:t.url, agent:cloudcli?record.cloudcliAgent:record.agent,...(cloudcli?{launchPath:'/__webdesktop/cmcp'}:{}), diagnostic:message => log(`[${t.name}] ${message}`),
          autoPassword:t.autoLogin===true ? async signal=>{if(!current()||signal.aborted)throw Error('Target stopped');const password=await passwordFor(t.name,signal);if(!current()||signal.aborted)throw Error('Target stopped');return password;} : undefined});
        if (!current()) { await record.gateway.close(); throw Error('Target stopped'); }
      }
      record.setup = async () => {
        const authKey = shared ? record.auth?.sessionId : record.auth;
        if (!current() || !record.connected || record.installing || Date.now() < record.retryAt || !authKey || (shared && authKey !== record.gateway.getSessionId())) return;
        if(record.installed===authKey)return;
        record.installing = true;
        const used = authKey;
        const epoch=record.connectionEpoch;
        const sameSession = () => current() && epoch===record.connectionEpoch && (!shared || used === record.gateway.getSessionId());
        publish(t.name, 'configuring', '正在配置此云电脑的 Claude MCP');
        try {
          const changed = await install(cloudcli?{...t,url:record.url}:t, record.auth, record.agent, signal,{cache:preparationCache});
          if (sameSession()&&record.connected) {
            record.installed = used;
            publish(t.name, 'connected', changed ? '共享会话已连接；MCP 配置已更新，请重启云端 Claude' : '共享会话已连接，Claude MCP 配置已确认');
          }
        } catch (error) {
          if (sameSession()&&record.connected) {
            publish(t.name, 'config-error', '共享连接已建立，但 Claude 配置失败，30 秒后重试');
            const stage = /^(?:relay-[a-z-]{1,24}|connector-(?:upload|install|confirm))$/.test(error.stage || '') ? error.stage : 'unknown';
            const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'SETUP_FAILED';
            const http = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : 0;
            const exit = Number.isInteger(error.commandExit) && error.commandExit >= 0 && error.commandExit <= 255 ? error.commandExit : '-';
            log(`[${t.name}] connector-setup stage=${stage} code=${code} http=${http} exit=${exit} ${connectionDetail(error)}`);
            record.retryAt = Date.now() + 30000;
          }
        } finally { record.installing = false; }
      };
      const linkStatus={set:(name,state,message)=>{if(['offline','recovering','waiting-login','replaced','stopped'].includes(state)){record.connected=false;record.installed=null;record.connectionEpoch++;}publish(name,state,message);},clients:(name,value)=>status.clients?.(name,value)};
      record.link = startLink({name:t.name, machine, version, catalog, askPassword, notify,status:linkStatus,log, session, onReplaced, deviceName, recoveryOptions, healthOptions,preparationCache,
        onHealth:value=>{unstable=value;if(confirmed)publish(confirmed.name,confirmed.state,confirmed.message);},
        forward:(msg, ctx) => { if (!current()) throw Error('Target stopped'); return forward(msg, ctx); },
        onConnected:async auth => { if (current()) { record.auth = auth;record.connected=true;record.retryAt=0;await record.setup(); }return {statusHandled:true}; },
        target:() => current() ? {
          url:record.url, stamp:t.stamp, authMode:shared ? 'shared-browser' : 'legacy',
          getSessionId:() => record.gateway?.getSessionId(),
          getSessionAuth:() => record.gateway?.getSessionAuth(),
          getLoginIssue:() => record.tunnel?.getIssue()||record.gateway?.getLoginIssue(),
          invalidateSession:id => record.gateway?.invalidateSession(id),
          password:() => passwordFor(t.name), proxy:() => record.tunnel?'':proxyFor(record.url, signal),
        } : null,
      });
      return record;
    } catch (error) {
      // close() may already have run while a gateway was still being created.
      record.agent?.destroy();record.cloudcliAgent?.destroy(); await record.gateway?.close();
        await record.tunnel?.close();
      await record.stop(); throw error;
    }
  };
}
