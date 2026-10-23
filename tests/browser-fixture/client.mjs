import {createElement} from 'react';
import {hydrateRoot} from 'react-dom/client';
import {Login} from './login.mjs';
// Deliberately expose editable SSR markup before React event handlers exist.
setTimeout(()=>{
  const input=document.querySelector('input');
  window.fixtureBeforeHydration={hasPlaceholder:input.value.startsWith('cmcp-auto-'),hasValue:!!input.value,clock:document.querySelector('#clock').textContent};
  hydrateRoot(document.querySelector('#root'),createElement(Login));
},1200);
