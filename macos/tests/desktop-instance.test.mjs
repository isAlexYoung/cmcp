import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createManager} from '../manager.mjs';
import {reuseDesktopManager} from '../desktop-instance.mjs';

test('repeated opens reuse the authenticated backend without closing tools or changing cloud preferences',async t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-desktop-reuse-')));
  let closed=0;
  const manager=await createManager({directory,version:'4.4.2',dispatcher:{forward:async()=>null,close:async()=>{closed++;}},secrets:async()=>{},detectShared:async()=>true,proxy:async()=>''});
  t.after(async()=>{await manager.close();fs.rmSync(directory,{recursive:true,force:true});});
  const id=await manager.store.save({url:'https://fixture.invalid',label:'Saved cloud',password:'',autoLogin:false,icon:''},async()=>true);
  const before=fs.readFileSync(path.join(directory,'targets.json'),'utf8');
  const controls=[...manager.store.controlMap()];
  const previous={pid:process.pid,origin:manager.origin,token:manager.token};
  for(let i=0;i<3;i++)assert.equal(await reuseDesktopManager(previous,{pid:process.pid,version:'4.4.2'}),true);
  assert.equal(closed,0);assert.equal(manager.store.targets[0].id,id);
  assert.equal(fs.readFileSync(path.join(directory,'targets.json'),'utf8'),before);
  assert.deepEqual([...manager.store.controlMap()],controls);
  assert.equal(await reuseDesktopManager(previous,{pid:process.pid,version:'4.4.3'}),false);
  assert.equal(await reuseDesktopManager({...previous,token:'0'.repeat(64)},{pid:process.pid,version:'4.4.2'}),false);
  assert.equal(closed,0);
});
test('invalid owner identity is rejected before any request and redirects cannot reveal the local token',async()=>{
  const previous={pid:123,origin:'http://127.0.0.1:1234',token:'a'.repeat(64)};
  for(const value of [{...previous,pid:124},{...previous,origin:'https://outside.invalid'},{...previous,token:'invalid'}]){
    await assert.rejects(reuseDesktopManager(value,{pid:123,version:'4.4.2',request:()=>assert.fail('invalid identity must not be requested')}),/identity/);
  }
  const request=async(url,options)=>{assert.equal(url,previous.origin+'/api/state');assert.equal(options.redirect,'error');assert.equal(options.headers['x-cmcp-token'],previous.token);throw Error('offline');};
  assert.equal(await reuseDesktopManager(previous,{pid:123,version:'4.4.2',request}),false);
});
