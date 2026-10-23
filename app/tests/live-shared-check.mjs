// Explicit read-only diagnostic. Reuses the running browser gateway: never logs
// into the cloud, creates a second PC link, or writes cloud configuration.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {requestBuffered} from '../desktop-auth.mjs';

const source = String.raw`
import json, os, runpy
from pathlib import Path
home = Path.home()
private = home / '.local/share/cloudpc-link/windows-pc-files'
connector = private / 'connector.py'
report = {'home': str(home), 'connector_exists': connector.is_file(), 'configs': []}
paths = [home / '.config/Claude/claude_desktop_config.json', home / '.claude.json']
xdg = os.environ.get('XDG_CONFIG_HOME')
if xdg and Path(xdg).is_absolute():
    extra = Path(xdg) / 'Claude/claude_desktop_config.json'
    if extra not in paths:
        paths.append(extra)
for file in paths:
    item = {'path': str(file), 'exists': file.is_file(), 'has_windows_mcp': False}
    if file.is_file():
        try:
            config = json.loads(file.read_text(encoding='utf-8-sig'))
            entry = config.get('mcpServers', {}).get('windows-pc-files')
            item['has_windows_mcp'] = isinstance(entry, dict)
            if isinstance(entry, dict):
                item['connector_matches'] = entry.get('args') == ['-u', str(connector), 'serve', '--name', 'windows-pc-files']
                item['executable_exists'] = Path(entry.get('command', '')).is_file()
        except Exception:
            item['parse_error'] = True
    report['configs'].append(item)
if connector.is_file():
    module = runpy.run_path(str(connector), run_name='mcp_diagnostic')
    link = module['Link']()
    catalog = link.fetch_catalog(wait=15)
    report['live_windows_tool_count'] = len(catalog['tools'])
    reply = link.request({'jsonrpc': '2.0', 'id': 'shared-live-check', 'method': 'tools/call',
                          'params': {'name': 'list_allowed_directories', 'arguments': {}}}, wait=15)
    report['read_only_tool_call_ok'] = 'error' not in reply and not reply.get('result', {}).get('isError', False)
print('MCP_SHARED_CHECK:' + json.dumps(report, ensure_ascii=False), flush=True)
`;

async function terminal(origin, headers) {
  const code = Buffer.from(source).toString('base64');
  const command = `python3 -c 'import base64; exec(base64.b64decode("${code}"))'; exit $?`;
  const url = new URL('/api/term/ws', origin.replace(/^http/, 'ws'));
  url.search = new URLSearchParams({sid:'mcp-shared-check-'+randomUUID(), cols:'200', rows:'30', cmd:command}).toString();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {headers, handshakeTimeout:20000, maxPayload:2*1024*1024});
    let done = false, output = '';
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({t:'kill'})); ws.close(); }
        else ws.terminate();
      } catch {}
      if (error) return reject(error);
      const match = /^MCP_SHARED_CHECK:(.+)\r?$/m.exec(output);
      try { if (!match) throw Error(); resolve(JSON.parse(match[1])); }
      catch { reject(Error('Cloud diagnostic did not return a report')); }
    };
    const timer = setTimeout(() => finish(Error('Cloud diagnostic timed out')), 75000);
    ws.on('message', (data, binary) => {
      if (binary) {
        output += data.toString('utf8');
        if (Buffer.byteLength(output) > 2*1024*1024) finish(Error('Cloud diagnostic output exceeded limit'));
        return;
      }
      let message; try { message=JSON.parse(data); } catch { return; }
      if (message?.t === 'exit') finish(message.code === 0 ? null : Error('Cloud diagnostic command failed'));
      else if (message?.t === 'error') finish(Error('Cloud diagnostic terminal failed'));
    });
    ws.on('error', () => finish(Error('Cloud diagnostic connection failed')));
    ws.on('close', () => finish(Error('Cloud diagnostic connection closed early')));
  });
}

try {
  const wanted = new URL(process.argv[2]).origin;
  const state = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'ClaudeLocalMcp', 'browser-entries.json'), 'utf8'));
  const entry = state.targets.find(item => new URL(item.url).origin === wanted);
  if (!entry) throw Error('Target has no shared browser entry; add it with Add-CloudPC.bat');
  // A service started elevated can reject even signal 0 on Windows. The
  // authenticated claim below verifies the live gateway without process access.
  const launch = new URL(entry.launchUrl);
  if (launch.protocol !== 'http:' || launch.hostname !== '127.0.0.1' || launch.username || launch.password || launch.pathname !== '/__mcp/open' || !/^#[A-Za-z0-9_-]{43}$/.test(launch.hash)) throw Error('Invalid local browser entry');
  const claim = await requestBuffered(new URL('/__mcp/claim', launch.origin), {method:'POST',
    headers:{origin:launch.origin, 'content-type':'application/json'}, body:JSON.stringify({token:launch.hash.slice(1)})});
  if (claim.status !== 204 || !claim.headers['set-cookie']?.[0]) throw Error('Local browser entry expired');
  const headers = {origin:launch.origin, cookie:claim.headers['set-cookie'][0].split(';')[0]};
  const session = await requestBuffered(new URL('/api/auth/session', launch.origin), {headers});
  if (session.status !== 200) throw Error('Log into the shared browser entry first; no login was submitted by this check');
  const report = await terminal(launch.origin, headers);
  console.log(JSON.stringify(report, null, 2));
  if (!report.read_only_tool_call_ok || !report.configs.slice(0,2).every(item => item.has_windows_mcp && item.connector_matches && item.executable_exists)) process.exitCode = 1;
} catch (error) {
  // Never print URLs, cookies, terminal buffers, or the local launch secret.
  console.error('SHARED_CHECK_FAILED: ' + error.message);
  process.exitCode = 1;
}
