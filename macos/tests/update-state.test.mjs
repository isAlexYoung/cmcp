import test from 'node:test';
import assert from 'node:assert/strict';
import {updateRing,updateView,updateSchedule,FIRST_CHECK_MS,CHECK_EVERY_MS} from '../ui/update-state.js';
import {checkFailed} from '../updates.mjs';

test('the progress ring follows the Mac checksum-before-download sequence without going backwards',()=>{
  let previous={},percentages=[];
  for(const value of [{phase:'release'},{phase:'checksum'},{phase:'download',received:0,total:100},{phase:'download',received:50,total:100},{phase:'download',received:100,total:100},{phase:'verify',received:100,total:100},{phase:'restart'}]){
    previous=updateRing({state:'updating',...value},previous);percentages.push(previous.percent);
  }
  assert.deepEqual(percentages,[0,8,10,47,85,99,100]);
});
test('failed updates retain their ring and retry or idle states reset it',()=>{
  const running=updateRing({state:'updating',phase:'download',received:70,total:100});
  const failed=updateRing({state:'failed',code:'checksum'},running);
  assert.equal(failed.percent,running.percent);assert.equal(failed.failed,true);assert.equal(failed.visible,true);
  assert.equal(updateRing({state:'updating',phase:'release'},failed).percent,0);
  assert.equal(updateRing({state:'available'},failed).visible,false);
  assert.equal(updateRing({state:'latest'},running).percent,0);
});
test('unknown or invalid stage counters never invent measured completion',()=>{
  for(const counters of [{},{received:5,total:0},{received:Infinity,total:10},{received:20,total:10},{received:-1,total:10}]){
    assert.equal(updateRing({state:'updating',phase:'download',...counters}).percent,10);
  }
});

test('an available version is offered with its number',()=>{
  const view=updateView({state:'available',version:'4.12.0'});
  assert.deepEqual([view.offered,view.version,view.button,view.busy,view.status],[true,'4.12.0','下载更新',false,'']);
});

test('nothing is offered before a check or once up to date',()=>{
  for(const updates of [undefined,{state:'unchecked',version:null},{state:'latest',version:null},{state:'error',version:null}]){
    const view=updateView(updates);assert.equal(view.offered,false);assert.equal(view.button,'下载更新');
  }
  assert.equal(updateView({state:'latest',version:null}).status,'已是最新版');
  assert.equal(updateView({state:'error',version:null}).status,'检查失败，请重试');
});

test('the version stays offered through an update and after it fails',()=>{
  const running=updateView({state:'updating',version:'4.12.0',phase:'download'});
  assert.deepEqual([running.offered,running.busy],[true,true]);
  const failed=updateView({state:'failed',version:'4.12.0',code:'network'});
  assert.deepEqual([failed.offered,failed.busy,failed.button],[true,false,'下载更新']);
});

test('a failure without a known version cannot enable a download',()=>{
  const view=updateView({state:'failed',code:'prepare'});
  assert.deepEqual([view.offered,view.button,view.busy],[false,'下载更新',false]);
});

test('checking blocks the button and says so',()=>{
  const view=updateView({state:'latest',version:null},true);
  assert.deepEqual([view.busy,view.status],[true,'正在检查…']);
});

test('a failed check does not take back a version already found',()=>{
  assert.deepEqual(checkFailed({state:'available',version:'4.12.0'}),{state:'available',version:'4.12.0',checkError:true});
  assert.deepEqual(checkFailed({state:'failed',version:'4.12.0',code:'network'}),{state:'available',version:'4.12.0',checkError:true});
  assert.deepEqual(checkFailed({state:'latest',version:null}),{state:'error',version:null});
  assert.deepEqual(checkFailed({state:'unchecked',version:null}),{state:'error',version:null});
});

test('a verified update stays ready to install while another check can run',()=>{
  const ready={state:'ready',phase:'ready',version:'4.17.4',received:1,total:1};
  assert.deepEqual([updateView(ready).offered,updateView(ready).prepared,updateView(ready).button,updateView(ready).busy],[true,true,'安装更新',false]);
  assert.equal(updateRing(ready).percent,100);
  assert.equal(updateView(ready,true).busy,true);
  assert.equal(updateView(ready,false,true).busy,true);
  assert.equal(updateView(checkFailed(ready)).prepared,true);
  assert.equal(updateView(checkFailed(ready)).status,'检查失败，请重试');
});

test('checks run shortly after start and then every six hours',()=>{
  let clock=1000,checks=0,beat;
  updateSchedule(()=>checks++,{now:()=>clock,repeat:(callback,period)=>{beat=callback;assert.ok(period<=FIRST_CHECK_MS);}});
  clock+=FIRST_CHECK_MS-1;beat();assert.equal(checks,0);
  clock+=1;beat();assert.equal(checks,1);
  beat();assert.equal(checks,1);
  clock+=CHECK_EVERY_MS-1;beat();assert.equal(checks,1);
  clock+=1;beat();assert.equal(checks,2);
  assert.equal(CHECK_EVERY_MS,21600000);
});

test('a Mac waking after days checks once, not once per missed period',()=>{
  let clock=0,checks=0,beat;
  const tick=updateSchedule(()=>checks++,{now:()=>clock,repeat:callback=>{beat=callback;}});
  clock=3*24*60*60*1000;tick();beat();tick();
  assert.equal(checks,1);
});
