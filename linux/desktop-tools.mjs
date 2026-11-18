import fs from 'node:fs';
import path from 'node:path';
import {define, integer, result, str, validator} from '../macos/schema.mjs';
import {detectBrowsers, openArguments} from './browsers.mjs';
import {executable, KIT, launch, runFile} from './platform.mjs';

const coordinate = integer(0, 65535);
const typingDelay = 12;
const keys = {type: 'array', items: {type: 'string', minLength: 1, maxLength: 32}, minItems: 1, maxItems: 32};
const definitions = [
  define('linux_browser_open', 'Open an HTTP/HTTPS URL on the physical Linux PC in its default browser, Chrome / Chromium, Edge, or Firefox.', {
    url: str, browser: {enum: ['default', 'chrome', 'edge', 'firefox']},
  }, ['url']),
  define('linux_screenshot', 'Capture a monitor or region of the physical Linux X11 desktop as a new PNG inside an allowed file root. Monitor is zero-based; x and y are pixels relative to that monitor.', {
    path: str, monitor: integer(0, 255), x: coordinate, y: coordinate, width: integer(1, 16384), height: integer(1, 16384),
  }, ['path']),
  define('linux_desktop_action', 'Move/click the pointer, type text, or send keys to the active app on the physical Linux X11 desktop. Mouse coordinates are absolute desktop pixels. Use names such as Return, Tab, Control, Shift, or F2.', {
    action: {enum: ['move_mouse', 'click', 'double_click', 'type_text', 'press_keys', 'hotkey']},
    x: coordinate, y: coordinate, text: {type: 'string', maxLength: 10000}, keys,
    button: {enum: ['left', 'right', 'middle']},
  }, ['action']),
];
const validate = validator(definitions);
const keyAliases = {
  ctrl: 'Control_L', control: 'Control_L', shift: 'Shift_L', alt: 'Alt_L', super: 'Super_L', win: 'Super_L',
  windows: 'Super_L', meta: 'Meta_L', enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape',
  escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', space: 'space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'Prior', pagedown: 'Next', prior: 'Prior', next: 'Next', print: 'Print', pause: 'Pause',
};
const keysym = /^(?:[A-Za-z0-9]|F(?:[1-9]|[12][0-9]|3[0-5])|(?:Control|Shift|Alt|Super|Meta)_[LR]|XF86[A-Za-z0-9]+|U[0-9A-Fa-f]{4,6})$/;

function keyStroke(text) {
  return text.split('+').map(part => {
    const alias = part.toLowerCase();
    if (Object.hasOwn(keyAliases, alias)) return keyAliases[alias];
    if (!keysym.test(part)) throw Error('Unsupported X11 key: ' + part);
    return part;
  }).join('+');
}

function desktopArguments(args) {
  const {action, x, y} = args;
  if (action === 'type_text') {
    if (typeof args.text !== 'string' || args.text.includes('\0')) throw Error('Supply text without NUL characters');
    return ['type', '--clearmodifiers', '--delay', String(typingDelay), '--', args.text];
  }
  if (action === 'press_keys' || action === 'hotkey') {
    if (!args.keys?.length) throw Error('Supply at least one key');
    const chords = args.keys.map(keyStroke);
    return ['key', '--clearmodifiers', ...(action === 'hotkey' ? [chords.join('+')] : chords)];
  }
  if ((x === undefined) !== (y === undefined) || (action === 'move_mouse' && x === undefined)) {
    throw Error('Supply both x and y desktop coordinates');
  }
  const move = x === undefined ? [] : ['mousemove', String(x), String(y)];
  if (action === 'move_mouse') return move;
  const button = {left: '1', middle: '2', right: '3'}[args.button ?? 'left'];
  return [...move, 'click', '--clearmodifiers', ...(action === 'double_click' ? ['--repeat', '2', '--delay', '50'] : []), button];
}

export function createLinuxDesktopTools({roots, env = process.env, run = runFile, open = launch, browsers = detectBrowsers}) {
  async function screenshot(args) {
    if (!path.isAbsolute(args.path) || !/\.png$/i.test(args.path)) throw Error('Use an absolute .png path');
    const parent = fs.realpathSync(path.dirname(args.path));
    if (!roots.some(root => {
      const rel = path.relative(fs.realpathSync(root), parent);
      return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    })) throw Error('Screenshot outside allowed roots');
    const destination = path.join(parent, path.basename(args.path));
    if (fs.existsSync(destination)) throw Error('Screenshot destination already exists');
    const temporary = fs.mkdtempSync(path.join(parent, '.cmcp-screen-'));
    const file = path.join(temporary, 'screen.png');
    try {
      const response = JSON.parse(await run('/usr/bin/python3', ['-B', path.join(KIT, 'capture_screen.py')], {
        input: JSON.stringify({...args, path: file}), env: {...env, GDK_BACKEND: 'x11', GDK_SCALE: '1'},
        timeout: 20000, maxBuffer: 8192,
      }));
      if (response.error) throw Error(response.error);
      const {size} = fs.statSync(file);
      if (!size) throw Error('The X11 screenshot is empty');
      fs.chmodSync(file, 0o600);
      fs.linkSync(file, destination);
      return result({...response, path: destination, size});
    } finally {
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  }

  return {definitions, async call(name, args) {
    validate(name, args);
    if (name === 'linux_browser_open') {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Only HTTP/HTTPS URLs without credentials are supported');
      const browser = args.browser ?? 'default';
      const selected = browser === 'default' ? null : browsers().find(item => item.id === browser);
      if (browser !== 'default' && !selected) throw Error('Browser unavailable on the Linux PC: ' + browser);
      await open(selected?.path ?? 'xdg-open', selected ? openArguments(selected, url.href) : [url.href]);
      return result({opened: true, browser, url: url.href});
    }
    if (!env.DISPLAY || (env.XDG_SESSION_TYPE && env.XDG_SESSION_TYPE !== 'x11')) {
      throw Error('This tool needs the physical Linux PC to be running an X11 desktop session');
    }
    if (name === 'linux_screenshot') return screenshot(args);
    const command = executable('xdotool', env);
    if (!command) throw Error('Linux mouse and keyboard tools require the xdotool package');
    const argv = desktopArguments(args);
    const timeout = 20000 + (args.action === 'type_text' ? typingDelay * args.text.length : 0);
    await run(command, argv, {env, timeout, maxBuffer: 8192});
    return result({sent: true, action: args.action});
  }};
}
