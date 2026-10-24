import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LABEL} from '../platform.mjs';
import {retireLegacyAgent} from '../legacy-agent.mjs';

function fixture(t){const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-migrate-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const state=path.join(home,'state'),directory=path.join(home,'Library/LaunchAgents'),file=path.join(directory,LABEL+'.plist');fs.mkdirSync(directory,{recursive:true});const document={Label:LABEL,ProgramArguments:['/old/node',path.join(state,'app/service.mjs')]};fs.writeFileSync(file,'original plist');const calls=[];const run=async(program,args)=>{calls.push(args[0]);return program.endsWith('plutil')?JSON.stringify(document):'';};return {home,state,directory,file,document,calls,uid:501,run};}
test('old login service is stopped and backed up without touching saved targets',async t=>{const f=fixture(t);assert.equal(await retireLegacyAgent(f),true);assert.deepEqual(f.calls,['-convert','print','bootout']);assert.equal(fs.existsSync(f.file),false);assert.equal(fs.readdirSync(f.directory).length,1);assert.equal(await retireLegacyAgent(f),false);});
test('another application with the old label is never stopped or renamed',async t=>{const f=fixture(t);f.document.ProgramArguments[1]='/another/service.mjs';await assert.rejects(retireLegacyAgent(f));assert.deepEqual(f.calls,['-convert']);assert.equal(fs.readFileSync(f.file,'utf8'),'original plist');});
test('failure stopping the old service leaves its launch file intact',async t=>{const f=fixture(t),run=f.run;f.run=async(p,a)=>{if(a[0]==='bootout')throw Error('denied');return run(p,a);};await assert.rejects(retireLegacyAgent(f));assert.equal(fs.existsSync(f.file),true);});
