# Third-party notices

## Claude Desktop icon

`app/assets/claude-desktop.ico` contains the original icon resources extracted from the user's locally installed, Anthropic-signed Claude Desktop for Windows 2.37337.1.0. The 14 image resources were copied into an ICO container without pixel changes, at the user's request. `tools/extract-claude-icon.py` records the extraction method. Icon SHA256: `aee6a768ee13e9bfa1aa60c358864f7e7cfaa1edf1749558056d2d9a53923972`.

Claude and the Claude icon are trademarks and property of Anthropic. No ownership or open-source license to these marks is claimed. This independent tool is not affiliated with or endorsed by Anthropic. The icon is embedded so end users do not need a local Claude installation. The rest of Claude Desktop is not included or redistributed.

## Node.js

Portable releases bundle the official Node.js Windows x64 runtime. Its license and third-party notices are included at `app/runtime/LICENSE`. The source repository omits `node.exe`; development and CI install or provide the runtime separately.

## JavaScript dependencies

Direct dependencies are pinned in `app/package.json` and `app/package-lock.json`: `@modelcontextprotocol/sdk`, `@modelcontextprotocol/server-filesystem`, `express`, and `ws`. Their own license files and the licenses of included transitive packages are retained in the release's `app/node_modules` tree. These licenses do not grant rights to the Claude trademarks or icon.
