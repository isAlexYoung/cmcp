import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installApp} from '../installer.mjs';
import {LABEL} from '../platform.mjs';

function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac-installer-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const kit=path.join(dir,'kit'),state=path.join(dir,'state'),agents=path.join(dir,'agents');
  for(const d of [kit,state,agents,path.join(state,'app')])fs.mkdirSync(d);
  fs.writeFileSync(path.join(kit,'service.mjs'),'new version');
  fs.writeFileSync(path.join(state,'app','service.mjs'),'old version');
  const plist=path.join(agents,LABEL+'.plist');fs.writeFileSync(plist,'old plist');
  fs.writeFileSync(path.join(state,'status.json'),JSON.stringify({targets:{old:{state:'connected'}}}));
  let running=true,failOnce=false;const calls=[];
  const run=async(file,args)=>{
    calls.push(args[0]);
    if(args[0]==='print'&&!running)throw Error('not loaded');
    if(args[0]==='bootout')running=false;
    if(args[0]==='bootstrap'){
      // Simulate launchd loading a job then failing its response, too.
      running=true;if(failOnce){failOnce=false;throw Error('injected bootstrap error');}
    }
    return '';
  };
  return{kit,state,agents,plist,calls,fail(){failOnce=true;},get running(){return running;},options:{kit,state,agents,node:'/node',uid:501,files:['service.mjs'],run}};
}

test('successful install publishes complete app, replaces plist and clears stale connection status',async t=>{
  const x=setup(t);await installApp(x.options);
  assert.equal(fs.readFileSync(path.join(x.state,'app','service.mjs'),'utf8'),'new version');
  assert.ok(fs.readFileSync(x.plist,'utf8').includes('<plist'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.state,'status.json'))).targets,{});
  assert.ok(x.running);assert.equal(fs.readdirSync(x.state).filter(n=>n.startsWith('app-')).length,0);
});

test('bootstrap failure restores old app and plist and restarts old service',async t=>{
  const x=setup(t);x.fail();await assert.rejects(installApp(x.options),/injected/);
  assert.equal(fs.readFileSync(path.join(x.state,'app','service.mjs'),'utf8'),'old version');
  assert.equal(fs.readFileSync(x.plist,'utf8'),'old plist');assert.ok(x.running);
  assert.equal(x.calls.filter(c=>c==='bootstrap').length,2);
  assert.equal(fs.readdirSync(x.state).filter(n=>n.startsWith('app-')).length,0);
});

test('incomplete installation source leaves running app and original configuration untouched',async t=>{
  const x=setup(t);fs.unlinkSync(path.join(x.kit,'service.mjs'));
  await assert.rejects(installApp(x.options),/ENOENT/);
  assert.equal(fs.readFileSync(path.join(x.state,'app','service.mjs'),'utf8'),'old version');
  assert.equal(fs.readFileSync(x.plist,'utf8'),'old plist');assert.ok(x.running);
  assert.deepEqual(x.calls,[]);
});
