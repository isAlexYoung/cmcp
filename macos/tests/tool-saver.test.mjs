// Quick clicks on the Mac Tools page become one save of each switch's last state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createSwitchSaver} from '../ui/tool-saver.js';

test('a burst of clicks is saved once, as the last state of each switch',async()=>{
  const saves=[];let saved=0;
  const saver=createSwitchSaver({delay:40,save:async value=>{saves.push(structuredClone(value));},onSaved:()=>saved++});
  for(let i=0;i<7;i++)saver.want('groups','blender',i%2===0);
  saver.want('tools','fx',true);saver.want('tools','fx',false);
  assert.equal(saves.length,0,'nothing is saved while clicks continue');
  assert.equal(saver.pending('groups','blender'),true);assert.equal(saver.busy,true);
  await delay(120);
  assert.deepEqual(saves,[{groups:{blender:true},tools:{fx:false}}]);assert.equal(saved,1);
  assert.equal(saver.pending('groups','blender'),false);assert.equal(saver.busy,false);
});

test('clicks during a save wait for it and are saved next, in order',async()=>{
  const saves=[];let release;
  const saver=createSwitchSaver({delay:20,save:async value=>{saves.push(structuredClone(value));if(saves.length===1)await new Promise(r=>{release=r;});}});
  saver.want('groups','files',false);await delay(60);
  assert.equal(saves.length,1);assert.equal(saver.pending('groups','files'),true,'still pending while its save runs');
  saver.want('groups','files',true);saver.want('groups','files',false);saver.want('groups','desktop',false);
  await delay(60);assert.equal(saves.length,1,'one save at a time');
  release();await delay(80);
  assert.deepEqual(saves,[{groups:{files:false},tools:{}},{groups:{files:false,desktop:false},tools:{}}]);
});

test('a failed save is reported and later clicks still save',async()=>{
  const errors=[],saves=[];let fail=true;
  const saver=createSwitchSaver({delay:10,save:async value=>{saves.push(value);if(fail){fail=false;throw Error('disk full');}},onError:e=>errors.push(e.message)});
  saver.want('tools','a',true);await delay(50);
  assert.deepEqual(errors,['disk full']);
  saver.want('tools','a',false);await delay(50);
  assert.equal(saves.length,2);assert.deepEqual(saves[1],{groups:{},tools:{a:false}});
  saver.want('tools','b',true);await saver.flush();assert.equal(saves.length,3,'flush saves at once');
});
