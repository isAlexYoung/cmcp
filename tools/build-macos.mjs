import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateBundle} from '../macos/update-transaction.mjs';

if(process.platform!=='darwin')throw Error('Build the native application on macOS');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'macos/package.json'),'utf8')).version;
const arch=process.arch;if(!['arm64','x64'].includes(arch))throw Error('Unsupported Mac architecture');
const output=path.resolve(process.argv[2]||path.join(root,'build-results','macos-'+arch));
fs.mkdirSync(output,{recursive:true});const bundle=path.join(output,'CMCP.app');
if(fs.existsSync(bundle))throw Error('Output already exists; choose a fresh build directory');
const contents=path.join(bundle,'Contents'),resources=path.join(contents,'Resources'),executable=path.join(contents,'MacOS');
for(const dir of [resources,executable,path.join(resources,'macos'),path.join(resources,'app'),path.join(resources,'runtime')])fs.mkdirSync(dir,{recursive:true});
const sourceFiles=['package.json','package-lock.json','platform.mjs','portable-state.mjs','finalize-update.mjs','schema.mjs','binary-tools.mjs','mac-tools.mjs','process-worker.mjs','dispatcher.mjs','tool-schemas.mjs','cloudpc-connector.py','keychain.jxa','keyboard.jxa','state.mjs','manager.mjs','updates.mjs','update-transaction.mjs','apply-update.mjs','desktop.mjs','legacy-agent.mjs','cloud-api.mjs','LICENSE','THIRD-PARTY-NOTICES.txt'];
sourceFiles.push('desktop-instance.mjs');
for(const name of sourceFiles)fs.copyFileSync(path.join(root,'macos',name),path.join(resources,'macos',name));
fs.cpSync(path.join(root,'macos/ui'),path.join(resources,'macos/ui'),{recursive:true});
fs.copyFileSync(path.join(root,'macos/runtime/FILESYSTEM-LICENSE.txt'),path.join(resources,'macos/FILESYSTEM-LICENSE.txt'));
const shared=['link-client.mjs','connection-transport.mjs','terminal-link.mjs','desktop-auth.mjs','direct-browser.mjs','shared-session-gateway.mjs','static-assets.mjs','web-recovery.mjs','shared-autofill.mjs','request-recovery.mjs','target-connections.mjs','managed-target.mjs','cloud-connector.mjs','cloudpc-relay.py'];
for(const name of shared)fs.copyFileSync(path.join(root,'app',name),path.join(resources,'app',name));
fs.cpSync(path.join(root,'macos/node_modules'),path.join(resources,'node_modules'),{recursive:true,filter:source=>!source.split(path.sep).includes('.bin')});
fs.copyFileSync(process.execPath,path.join(resources,'runtime/node'));fs.chmodSync(path.join(resources,'runtime/node'),0o755);
fs.copyFileSync(path.join(root,'macos/runtime/NODE-LICENSE.txt'),path.join(resources,'runtime/LICENSE'));
// The original 1024 px master (tools/draw-cmcp-icon.py) feeds every Retina size; nothing is upscaled.
const image=fs.readFileSync(path.join(root,'app/assets/cmcp-icon-1024.png'));
if(!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||image.readUInt32BE(16)!==1024||image.readUInt32BE(20)!==1024)throw Error('CMCP icon master must be a 1024 px PNG');
const icons=path.join(output,'AppIcon.iconset');fs.mkdirSync(icons);const base=path.join(output,'icon-base.png');fs.writeFileSync(base,image);
for(const size of [16,32,128,256,512])for(const scale of [1,2])execFileSync('/usr/bin/sips',['-z',String(size*scale),String(size*scale),base,'--out',path.join(icons,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{stdio:'ignore'});
execFileSync('/usr/bin/iconutil',['-c','icns',icons,'-o',path.join(resources,'AppIcon.icns')]);
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CMCP</string><key>CFBundleIdentifier</key><string>com.cmcp.manager</string><key>CFBundleName</key><string>CMCP</string><key>CFBundleDisplayName</key><string>CMCP</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleIconFile</key><string>AppIcon</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict><key>NSAppleEventsUsageDescription</key><string>CMCP uses automation only when you request a desktop action.</string></dict></plist>`;
fs.writeFileSync(path.join(contents,'Info.plist'),plist);
execFileSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-O','-target',`${arch==='x64'?'x86_64':'arm64'}-apple-macos13.0`,'-framework','AppKit','-framework','WebKit','-framework','ServiceManagement','-framework','ApplicationServices',path.join(root,'macos/native/CMCP.swift'),'-o',path.join(executable,'CMCP')],{stdio:'inherit'});
const files=[];
function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink()||!entry.isFile()&&!entry.isDirectory())throw Error('Special file in package');if(entry.isDirectory())visit(file);else{const name=path.relative(bundle,file).split(path.sep).join('/');if(/^\.env|^(?:targets|status|manager-instance|application-preferences|target-controls)\.json$/.test(entry.name)||['.log','.pem','.key','.p12'].includes(path.extname(entry.name)))throw Error('Private file in package');files.push(name==='Contents/MacOS/CMCP'?{path:name,codeSignature:true}:{path:name,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}}
visit(bundle);const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
fs.writeFileSync(path.join(resources,'distribution-manifest.json'),JSON.stringify({schema:1,version,platform:'macos-'+arch,sourceCommit:commit,files},null,2));
execFileSync('/usr/bin/codesign',['--force','--sign','-',bundle],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
validateBundle(bundle,{version,arch});
const smoke=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cmcp-bundle-smoke-')));
const module=JSON.stringify(new URL('file://'+path.join(resources,'macos/manager.mjs')).href);
execFileSync(path.join(resources,'runtime/node'),['--use-system-ca','--input-type=module','-e',`import {createManager} from ${module}; const m=await createManager({directory:${JSON.stringify(smoke)}}); await m.close(); console.log('Bundled backend smoke passed');`],{stdio:'inherit'});
console.log(JSON.stringify({bundle,version,platform:'macos-'+arch,files:files.length}));
