import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {markChosen,MENU_MS,menuKey,menuPlace,pageDirection,revealGuard,REVEAL_MS,turn} from '../ui/motion.js';

const css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');

function fakeNode(){
  const classes=new Set(),log=[];
  return {log,classes,classList:{
    add(name){classes.add(name);log.push('add '+name);},
    remove(...names){for(const name of names)classes.delete(name);log.push('remove');},
    toggle(name,on){on?classes.add(name):classes.delete(name);},
    contains(name){return classes.has(name);},
  },get offsetWidth(){log.push('layout');return 0;}};
}

test('pages turn forward going deeper and back going out',()=>{
  assert.equal(pageDirection('home','settings'),1);
  assert.equal(pageDirection('home','editor'),1);
  assert.equal(pageDirection('settings','about'),1);
  assert.equal(pageDirection('about','settings'),-1);
  assert.equal(pageDirection('settings','home'),-1);
  assert.equal(pageDirection('about','home'),-1);
  assert.equal(pageDirection('editor','home'),-1);
  assert.equal(pageDirection('settings','editor'),1);
  assert.equal(pageDirection('editor','editor'),0);
});

test('a turn restarts the animation by forcing layout between removing and adding its class',()=>{
  const node=fakeNode();
  turn(node,1);
  assert.deepEqual(node.log,['remove','layout','add turn-forward']);
  node.log.length=0;
  turn(node,-1);
  assert.deepEqual(node.log,['remove','layout','add turn-back']);
  assert.deepEqual([...node.classes],['turn-back']);
});

test('no direction means no animation, not a leftover one',()=>{
  const node=fakeNode();
  turn(node,1);
  turn(node,0);
  assert.equal(node.classes.size,0);
});

test('exactly one segment is chosen and announced',()=>{
  const options=['light','dark','system'].map(value=>{
    const option=fakeNode();option.dataset={value};option.attributes={};
    option.setAttribute=(name,text)=>{option.attributes[name]=text;};
    return option;
  });
  const group={querySelectorAll:selector=>{assert.equal(selector,'button');return options;}};
  markChosen(group,'dark');
  assert.deepEqual(options.map(option=>option.classList.contains('chosen')),[false,true,false]);
  assert.deepEqual(options.map(option=>option.attributes['aria-pressed']),['false','true','false']);
  markChosen(group,'system');
  assert.deepEqual(options.map(option=>option.classList.contains('chosen')),[false,false,true]);
});

test('a card slide holds back list rebuilds only for as long as it lasts',()=>{
  let clock=1000;
  const guard=revealGuard(()=>clock);
  assert.equal(guard.active(),false);
  guard.start();
  assert.equal(guard.active(),true);
  clock+=REVEAL_MS-1;
  assert.equal(guard.active(),true);
  clock+=1;
  assert.equal(guard.active(),false);
});

test('style sheet timing matches the Windows interface',()=>{
  assert.match(css,/\.accordion\{[^}]*transition:grid-template-rows \.17s/);
  assert.equal(REVEAL_MS,170);
  assert.match(css,/\.turn-forward\{animation:turn-forward \.18s/);
  assert.match(css,/\.turn-back\{animation:turn-back \.18s/);
  assert.match(css,/button\{[^}]*transition:background-color \.11s/);
  assert.match(css,/@keyframes turn-forward\{from\{opacity:0;transform:translateX\(20px\)\}\}/);
  assert.match(css,/@keyframes turn-back\{from\{opacity:0;transform:translateX\(-20px\)\}\}/);
});

test('animations rest on the natural state, so nothing depends on them finishing',()=>{
  for(const rule of css.match(/\.turn-(forward|back)\{[^}]*\}/g))assert.doesNotMatch(rule,/forwards|both|backwards|pointer-events/);
});

test('system reduced motion still turns off every transition and animation',()=>{
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{transition:none!important;animation:none!important\}\}/);
});

test('collapsed card details leave the tab order only after the slide ends',()=>{
  assert.match(css,/\.accordion>div\{[^}]*visibility:hidden;transition:visibility 0s linear \.17s\}/);
  assert.match(css,/\.expanded \.accordion>div\{visibility:visible;transition-delay:0s\}/);
});

test('a dropdown list opens under its field and above it only when that is all that fits',()=>{
  const field={left:300,width:150,top:120,bottom:156};
  assert.deepEqual(menuPlace(field,78,472),{left:300,width:150,above:false,top:158});
  assert.deepEqual(menuPlace({...field,top:420,bottom:456},78,472),{left:300,width:150,above:true,top:340});
  assert.equal(menuPlace({...field,top:352,bottom:388},78,472).above,false);
  assert.equal(menuPlace({...field,top:20,bottom:56},78,100).above,false);
  assert.equal(menuPlace({...field,top:60,bottom:96},78,100).top,4);
});

test('a closed dropdown opens on Enter, Space and the arrows and ignores other keys',()=>{
  for(const key of ['Enter',' ','ArrowDown','ArrowUp'])assert.deepEqual(menuKey(key,false,0,2),{action:'open'});
  for(const key of ['Escape','Tab','Home','End','a'])assert.equal(menuKey(key,false,0,2),null);
});

test('an open dropdown moves with the arrows, stops at the ends, and picks or closes',()=>{
  assert.deepEqual(menuKey('ArrowDown',true,0,2),{action:'move',cursor:1});
  assert.deepEqual(menuKey('ArrowDown',true,1,2),{action:'move',cursor:1});
  assert.deepEqual(menuKey('ArrowUp',true,1,2),{action:'move',cursor:0});
  assert.deepEqual(menuKey('ArrowUp',true,0,2),{action:'move',cursor:0});
  assert.deepEqual(menuKey('Home',true,1,2),{action:'move',cursor:0});
  assert.deepEqual(menuKey('End',true,0,2),{action:'move',cursor:1});
  for(const key of ['Enter',' '])assert.deepEqual(menuKey(key,true,1,2),{action:'pick'});
  assert.deepEqual(menuKey('Escape',true,1,2),{action:'close'});
  assert.deepEqual(menuKey('Tab',true,1,2),{action:'leave'});
  assert.equal(menuKey('a',true,1,2),null);
});

test('the dropdown folds in the same 130 ms as Windows, fading as it goes',()=>{
  assert.equal(MENU_MS,130);
  assert.match(css,/\.select-list\{[^}]*opacity:0;clip-path:inset\(0% 0% 100% 0%\);transition:opacity \.13s var\(--ease\),clip-path \.13s var\(--ease\)\}/);
  assert.match(css,/\.select-list\.open\{pointer-events:auto;opacity:1;clip-path:inset\(0% 0% 0% 0%\)\}/);
});

test('the dropdown list escapes every card and scrolling area and rows fill its width',()=>{
  assert.match(css,/\.select-list\{position:fixed;z-index:30;padding:4px 0;/);
  assert.match(css,/\.select-option\{display:flex;align-items:center;height:34px;padding:0 12px;/);
  assert.match(app,/document\.body\.append\(list\)/);
  assert.doesNotMatch(app,/el\('select'|el\('option'/);
});

test('the current row uses the Windows mix of surface and blue, in both themes',()=>{
  const channels=hex=>(hex.length===4?[1,2,3].map(start=>hex[start]+hex[start]):[1,3,5].map(start=>hex.slice(start,start+2))).map(pair=>parseInt(pair,16));
  const mix=(from,to,level)=>'#'+channels(from).map((value,index)=>Math.round(value+(channels(to)[index]-value)*level).toString(16).padStart(2,'0')).join('');
  const light=css.match(/:root\{[^}]*\}/)[0],dark=css.match(/:root\[data-theme=dark\]\{[^}]*\}/)[0];
  const token=(block,name)=>block.match(new RegExp('--'+name+':(#[0-9a-f]+)'))[1];
  for(const block of [light,dark]){
    assert.equal(token(block,'chosen'),mix(token(block,'surface'),token(block,'blue'),.22));
    assert.equal(token(block,'chosen-hot'),mix(token(block,'surface'),token(block,'blue'),.32));
  }
  assert.match(css,/\.select-option\.active\{background:var\(--active\)\}\.select-option\.chosen\{background:var\(--chosen\)\}\.select-option\.chosen\.active\{background:var\(--chosen-hot\)\}/);
});

test('a chosen segment stays blue while hovered',()=>{
  assert.match(css,/\.segments button\.chosen,\.segments button\.chosen:hover\{background:var\(--blue\);color:#fff\}/);
});
