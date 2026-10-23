// Optional live check: public page and static asset only. No cloud login,
// no MCP link, no cloud file writes, and no persistent local state.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {agentFor} from '../link-client.mjs';
import {createSharedSessionGateway} from '../shared-session-gateway.mjs';
import {requestBuffered} from '../desktop-auth.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const {stdout}=await promisify(execFile)(ps,['-NoProfile','-File',path.join(base,'get-proxy.ps1'),'-Url',process.argv[2]],{windowsHide:true,timeout:30000});
const agent=agentFor(process.argv[2],stdout.trim());
let gateway;
try {
  gateway=await createSharedSessionGateway({baseUrl:process.argv[2],name:'read-only-check',agent});
  const launch=new URL(gateway.launchUrl);
  assert.equal((await requestBuffered(launch.origin+launch.pathname)).status,200);
  const claim=await requestBuffered(launch.origin+'/__mcp/claim',{method:'POST',headers:{origin:launch.origin,'content-type':'application/json'},body:JSON.stringify({token:launch.hash.slice(1)})});
  assert.equal(claim.status,204);
  const headers={origin:launch.origin,cookie:claim.headers['set-cookie'][0].split(';')[0]};
  const page=await requestBuffered(launch.origin+'/',{headers});
  assert.equal(page.status,200);
  const src=/<script\b[^>]*\bsrc="([^"]+)"/.exec(page.body.toString('utf8'))?.[1];
  assert.ok(src);
  const relative=new URL(src,new URL(process.argv[2]));assert.equal(relative.origin,new URL(process.argv[2]).origin);
  assert.equal((await requestBuffered(launch.origin+relative.pathname+relative.search,{headers})).status,200);
  assert.equal(gateway.getSessionId(),null);
  console.log('LIVE_READ_ONLY_OK: shared entry, cloud HTML and JavaScript reachable; no cloud login submitted');
} finally { await gateway?.close();agent?.destroy(); }
