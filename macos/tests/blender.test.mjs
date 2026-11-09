// Exercise the same real add-on socket protocol and Mac SSH dispatcher on macOS.
import '../../app/tests/blender.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {createDispatcher} from '../dispatcher.mjs';

test('Mac web and SSH dispatcher route Blender calls without sending them to the filesystem',async t=>{
  const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.once('data',data=>{const command=JSON.parse(data);assert.equal(command.type,'get_scene_info');socket.write(JSON.stringify({status:'success',result:{name:'Mac live scene'}}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  // Blender is off until the user switches it on (tool-settings.json).
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-mac-blender-'));t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  fs.writeFileSync(path.join(state,'tool-settings.json'),JSON.stringify({schema:1,groups:{blender:true}}));
  const dispatcher=await createDispatcher({roots:[os.tmpdir()],stateDir:state,filesystem:{listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('Blender must not reach the filesystem');},close:async()=>{}}});
  t.after(()=>dispatcher.close());
  const call=(method,params)=>dispatcher.forward({jsonrpc:'2.0',id:1,method,params});
  assert.match((await call('initialize',{protocolVersion:'2025-03-26'})).result.instructions,/currently open Blender/);
  assert.ok((await call('tools/list')).result.tools.some(d=>d.name==='blender_execute_code'));
  const result=await call('tools/call',{name:'blender_get_scene_info',arguments:{port:server.address().port}});
  assert.equal(JSON.parse(result.result.content[0].text).name,'Mac live scene');
});
