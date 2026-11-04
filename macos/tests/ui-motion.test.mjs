import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {markChosen,pageDirection,revealGuard,REVEAL_MS,turn} from '../ui/motion.js';

const css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');

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

test('a chosen segment stays blue while hovered',()=>{
  assert.match(css,/\.segments button\.chosen,\.segments button\.chosen:hover\{background:var\(--blue\);color:#fff\}/);
});
