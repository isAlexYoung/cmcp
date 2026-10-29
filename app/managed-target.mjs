import {agentFor, startLink} from './link-client.mjs';
import {requiresSharedSession} from './desktop-auth.mjs';
import {createSharedSessionGateway} from './shared-session-gateway.mjs';
import {Cloud} from './cloud-connector.mjs';
import {supportsDirectBrowser,createDirectBrowser} from './direct-browser.mjs';

// The production target factory is also exercised against independent local
// HTTP/WebSocket desktops. Each target owns its agent, gateway and setup lease.
export function managedTargetFactory({proxyFor, machine, version, forward, askPassword, notify, log, deviceName, recoveryOptions, healthOptions,
  passwordFor, session = false, onReplaced, install = (t, auth, agent, signal) => new Cloud(t.url, auth, agent, signal).install()}) {
  return async (t, {signal, current, status}) => {
    const record = {name:t.name, url:t.url, installed:null, installing:false, retryAt:0, auth:null,connected:false,connectionEpoch:0};
    // Soft probe failures must not revoke setup leases or discard confirmed config.
    let unstable=false,confirmed;
    const publish=(name,state,message)=>{
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
        record.agent?.destroy();
      })();
      return stopping;
    };
    signal.addEventListener('abort', record.stop, {once:true});
    try {
      signal.throwIfAborted();
      publish(t.name, 'connecting', '正在检查登录协议（不会提交密码）');
      const proxy = await proxyFor(t.url, signal);
      signal.throwIfAborted();
      record.agent = agentFor(t.url, proxy);
      const shared = t.authMode === 'shared-browser' || await requiresSharedSession(t.url, record.agent, signal);
      signal.throwIfAborted();
      if (!current()) throw Error('Target stopped');
      if (shared) {
        const gateway = await supportsDirectBrowser(t.url,record.agent,signal) ? createDirectBrowser : createSharedSessionGateway;
        record.gateway = await gateway({name:t.name, baseUrl:t.url, agent:record.agent, diagnostic:message => log(`[${t.name}] ${message}`),
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
          const changed = await install(t, record.auth, record.agent, signal);
          if (sameSession()&&record.connected) {
            record.installed = used;
            publish(t.name, 'connected', changed ? '共享会话已连接；MCP 配置已更新，请重启云端 Claude' : '共享会话已连接，Claude MCP 配置已确认');
          }
        } catch (error) {
          if (sameSession()&&record.connected) {
            publish(t.name, 'config-error', '共享连接已建立，但 Claude 配置失败，30 秒后重试');
            log(`[${t.name}] shared connector setup failed (${error.status || error.code || 'setup'})`);
            record.retryAt = Date.now() + 30000;
          }
        } finally { record.installing = false; }
      };
      const linkStatus={set:(name,state,message)=>{if(['offline','recovering','waiting-login','replaced','stopped'].includes(state)){record.connected=false;record.installed=null;record.connectionEpoch++;}publish(name,state,message);}};
      record.link = startLink({name:t.name, machine, version, askPassword, notify,status:linkStatus,log, session, onReplaced, deviceName, recoveryOptions, healthOptions,
        onHealth:value=>{unstable=value;if(confirmed)publish(confirmed.name,confirmed.state,confirmed.message);},
        forward:msg => { if (!current()) throw Error('Target stopped'); return forward(msg); },
        onConnected:async auth => { if (current()) { record.auth = auth;record.connected=true;record.retryAt=0;await record.setup(); }return {statusHandled:true}; },
        target:() => current() ? {
          url:t.url, stamp:t.stamp, authMode:shared ? 'shared-browser' : 'legacy',
          getSessionId:() => record.gateway?.getSessionId(),
          getSessionAuth:() => record.gateway?.getSessionAuth(),
          getLoginIssue:() => record.gateway?.getLoginIssue(),
          invalidateSession:id => record.gateway?.invalidateSession(id),
          password:() => passwordFor(t.name), proxy:() => proxyFor(t.url, signal),
        } : null,
      });
      return record;
    } catch (error) {
      // close() may already have run while a gateway was still being created.
      record.agent?.destroy(); await record.gateway?.close();
      await record.stop(); throw error;
    }
  };
}
