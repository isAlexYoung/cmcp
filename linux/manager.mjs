import {createManager as createSharedManager} from '../macos/manager.mjs';
import {STATE, VERSION, keychain, proxyFor, launch} from './platform.mjs';
import {createDispatcher} from './dispatcher.mjs';
import {Cloud} from './cloud-api.mjs';
import {webTunnelEnvironment, openTerminal, detectTerminals, closeSessions} from './ssh.mjs';
import {detectBrowsers, openPage, closePages} from './browsers.mjs';
import {checkRelease, downloadUpdate} from './updates.mjs';

export const CAPABILITIES = Object.freeze({tray: true, autostart: false, shortcut: false, selfUpdate: true, nativeUninstall: false, desktopControl: false, blender: false});
export async function createManager(options = {}) {
  const directory = options.directory || STATE;
  const dispatcher = options.dispatcher || await createDispatcher({roots: (await import('../macos/platform.mjs')).readConfig(directory).roots, stateDir: directory});
  try {
    return await createSharedManager({directory, version: VERSION, platform: 'linux', platformLabel: 'linux-' + process.arch, capabilities: CAPABILITIES,
      secrets: keychain, proxy: proxyFor, dispatcher,
      install: (target, auth, agent, signal, preparation) => new Cloud(target.url, auth, agent, signal, preparation).install(),
      removeCloud: async () => { throw Error('原生卸载尚未实现；请使用系统包管理器。'); },
      installation: {check() { throw Error('请通过 sudo apt remove cmcp 卸载应用；用户设置与密码会保留。'); }, launch() {}},
      launchTerminal: openTerminal, terminals: detectTerminals, browsers: detectBrowsers, openBrowserPage: openPage, closeBrowserPages: closePages, closeTerminals: closeSessions,
      tunnelEnvironment: webTunnelEnvironment, checkUpdate: checkRelease, prepareUpdate: downloadUpdate,
      openLocal: target => launch('xdg-open', [target]), ...options});
  } catch (error) { await dispatcher.close(); throw error; }
}
