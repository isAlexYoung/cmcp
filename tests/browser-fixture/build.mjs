import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Login} from './login.mjs';
export function reactFixture(){
  const script=buildSync({entryPoints:[fileURLToPath(new URL('./client.mjs',import.meta.url))],bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  const html='<!doctype html><html><head><meta charset="utf-8"><script nonce="fixtureAutoNonce123" defer src="/login-fixture.js"></script></head><body><div id="root">'+renderToString(createElement(Login))+'</div></body></html>';
  return {script,html};
}
