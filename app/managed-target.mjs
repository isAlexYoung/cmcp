import {agentFor, startLink} from './link-client.mjs';
import {requiresSharedSession} from './desktop-auth.mjs';
import {createSharedSessionGateway} from './shared-session-gateway.mjs';
import {Cloud} from './cloud-connector.mjs';
import {supportsDirectBrowser,createDirectBrowser} from './direct-browser.mjs';
import {connectionDetail} from './connection-transport.mjs';
import {discoverCloudcli,createLaunchPage,cloudcliDevice,SELF_HOSTED,WEBDESKTOP} from './cloudcli.mjs';
import {requestBuffered} from './desktop-auth.mjs';

// Fixed texts, so the Windows card may show them as they are (Manager.cs PreparationDetail).
export const SELF_HOSTED_READY='自行安装的 CloudCLI：网页可以打开；本机工具经此设备的 SSH 后台通道连接。';
export const SELF_HOSTED_DOWN='自行安装的 CloudCLI 暂时无法访问，正在重试。';

// The production target factory is also exercised against independent local
// HTTP/WebSocket desktops. Each target owns its agent, gateway and setup lease.
export function managedTargetFactory({proxyFor, machine, version, forward, catalog, askPassword, notify, log, deviceName, recoveryOptions, healthOptions,
  openTunnel, passwordFor, session = false, onReplaced, onCloudcliKind = () => {}, selfHostedProbeMs = 15000, install = (t, auth, agent, signal, preparation) => new Cloud(t.url, auth, agent, signal,preparation).install()}) {
  return async (t, {signal, current, status}) => {
    const record = {name:t.name, url:t.url, installed:null, installing:false, retryAt:0, auth:null,connected:false,connectionEpoch:0};
    const preparationCache={};
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
      stopping = (async () => {
        await record.link?.stop();
        await record.gateway?.close();
        await record.tunnel?.close();
        record.agent?.destroy();
        record.cloudcliAgent?.destroy();
      })();
      return stopping;
    };
    signal.addEventListener('abort', record.stop, {once:true});
    try {
      signal.throwIfAborted();
      if(t.tunnel){if(!openTunnel)throw Error('SSH tunnel is unavailable');record.tunnel=await openTunnel(t,signal);t={...t,url:record.tunnel[t.tunnel.app]};record.url=t.url;}
      publish(t.name, 'connecting', '正在检查登录协议（不会提交密码）');
      const proxy = record.tunnel?'':await proxyFor(t.url, signal);
      signal.throwIfAborted();
      record.agent = agentFor(t.url, proxy);
      const cloudcli=t.authMode==='cloudcli';
      if(cloudcli){
        let discovered;
        try{discovered=await discoverCloudcli(t.url,record.agent,signal);}
        catch(error){
          if(!error.selfHosted)throw error;
          // No CMCP sign-in and no web MCP here: the page opens as it is, with CloudCLI's own login,
          // and the device's SSH background channel carries the local tools. A later bridge
          // transport would replace that channel, not this entrance.
          const device=cloudcliDevice(t.name);if(device)try{onCloudcliKind(device,SELF_HOSTED);}catch{}
          record.selfHosted=true;record.gateway=await createLaunchPage({url:t.url});
          if(!current()){await record.gateway.close();throw Error('Target stopped');}
          let up=true;publish(t.name,'connected',SELF_HOSTED_READY);
          const probe=setInterval(async()=>{
            if(!current()||signal.aborted)return;
            try{const r=await requestBuffered(new URL('/',t.url),{agent:record.agent,signal,timeout:10000,limit:262144});up=r.status<500;}catch{up=false;}
            if(current()&&!signal.aborted)publish(t.name,up?'connected':'offline',up?SELF_HOSTED_READY:SELF_HOSTED_DOWN);
          },selfHostedProbeMs);probe.unref?.();
          signal.addEventListener('abort',()=>clearInterval(probe),{once:true});
          return record;
        }
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
            log(`[${t.name}] shared connector setup failed (${error.status || error.code || 'setup'}) ${connectionDetail(error)}`);
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
