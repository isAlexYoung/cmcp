import {agentFor, startLink} from './link-client.mjs';
import {requiresSharedSession} from './desktop-auth.mjs';
import {createSharedSessionGateway} from './shared-session-gateway.mjs';
import {Cloud} from './cloud-connector.mjs';

// The production target factory is also exercised against independent local
// HTTP/WebSocket desktops. Each target owns its agent, gateway and setup lease.
export function managedTargetFactory({proxyFor, machine, version, forward, askPassword, notify, log, deviceName, recoveryOptions,
  passwordFor, session = false, onReplaced, install = (t, auth, agent, signal) => new Cloud(t.url, auth, agent, signal).install()}) {
  return async (t, {signal, current, status}) => {
    const record = {name:t.name, url:t.url, installed:null, installing:false, retryAt:0, auth:null};
    let closed = false;
    let stopping;
    record.stop = () => {
      if (closed) return stopping;
      closed = true;
      stopping = (async () => {
        await record.link?.stop();
        record.agent?.destroy();
        await record.gateway?.close();
      })();
      return stopping;
    };
    signal.addEventListener('abort', record.stop, {once:true});
    try {
      signal.throwIfAborted();
      status.set(t.name, 'connecting', '正在检查登录协议（不会提交密码）');
      const proxy = await proxyFor(t.url, signal);
      signal.throwIfAborted();
      record.agent = agentFor(t.url, proxy);
      const shared = t.authMode === 'shared-browser' || await requiresSharedSession(t.url, record.agent, signal);
      signal.throwIfAborted();
      if (!current()) throw Error('Target stopped');
      if (shared) {
        record.gateway = await createSharedSessionGateway({name:t.name, baseUrl:t.url, agent:record.agent, diagnostic:message => log(`[${t.name}] ${message}`),
          autoPassword:t.autoLogin===true ? async signal=>{if(!current()||signal.aborted)throw Error('Target stopped');const password=await passwordFor(t.name,signal);if(!current()||signal.aborted)throw Error('Target stopped');return password;} : undefined});
        if (!current()) { await record.gateway.close(); throw Error('Target stopped'); }
      }
      record.setup = async () => {
        const authKey = shared ? record.auth?.sessionId : record.auth;
        if (!current() || record.installing || Date.now() < record.retryAt || !authKey || (shared && authKey !== record.gateway.getSessionId()) || record.installed === authKey) return;
        record.installing = true;
        const used = authKey;
        const sameSession = () => current() && (!shared || used === record.gateway.getSessionId());
        status.set(t.name, 'configuring', '正在配置此云电脑的 Claude MCP');
        try {
          const changed = await install(t, record.auth, record.agent, signal);
          if (sameSession()) {
            record.installed = used;
            status.set(t.name, 'connected', changed ? '共享会话已连接；MCP 配置已更新，请重启云端 Claude' : '共享会话已连接，Claude MCP 配置已确认');
          }
        } catch (error) {
          if (sameSession()) {
            status.set(t.name, 'config-error', '共享连接已建立，但 Claude 配置失败，30 秒后重试');
            log(`[${t.name}] shared connector setup failed (${error.status || error.code || 'setup'})`);
            record.retryAt = Date.now() + 30000;
          }
        } finally { record.installing = false; }
      };
      record.link = startLink({name:t.name, machine, version, askPassword, notify, status, log, session, onReplaced, deviceName, recoveryOptions,
        forward:msg => { if (!current()) throw Error('Target stopped'); return forward(msg); },
        onConnected:auth => { if (current()) { record.auth = auth; return record.setup(); } },
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
