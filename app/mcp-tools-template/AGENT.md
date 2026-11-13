# mcp-tools: adding a local MCP tool to CMCP (interface cmcp-tools/1)

> 中文摘要：这个文件夹里每个子文件夹是一个"本机工具"。CMCP 在这台电脑上运行它（一个 MCP 服务器），再把它的工具转给 VPS 上的 Claude。
> 写一个 `cmcp-tool.json` 就能接入 GitHub 上大多数 MCP 服务器。不要把密钥写进这个文件夹。写完用下面"本地测试"一节的命令检查。

This folder belongs to the user. CMCP keeps it when it updates or is uninstalled. Each
subfolder is one tool: CMCP runs an MCP server on this computer and forwards its tools to
Claude on the user's VPS, over CMCP's web or SSH channel. Folders starting with `_` or `.`
are ignored (`_examples` holds copyable examples).

## 1. Fastest path: an existing MCP server

Most MCP servers on GitHub document a Claude Desktop snippet like:

```json
{"mcpServers": {"blender": {"command": "uvx", "args": ["mcp-for-blender"]}}}
```

The user can paste that into CMCP > Settings > Tools > Add tool. To do it by hand, create
`mcp-tools/<id>/cmcp-tool.json`:

```json
{
  "schema": 1,
  "name": "MCP for Blender",
  "description": "Control the open Blender through its add-on.",
  "homepage": "https://github.com/ahujasid/blender-mcp",
  "version": "2.2.5",
  "transport": "stdio",
  "command": "uvx",
  "args": ["mcp-for-blender==2.2.5"],
  "capabilities": ["files", "python", "network", "gui"]
}
```

Node packages work the same way: `"command": "npx", "args": ["-y", "some-mcp@1.2.3"]`.

A new tool is **off** until the user turns it on in CMCP and confirms what it can do.

## 2. cmcp-tool.json, schema 1

The full JSON Schema is in `cmcp-tool.schema.json` next to this file.

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Always `1`. |
| `name` | yes | Display name, 1-60 characters. |
| `description` | yes | One sentence, at most 200 characters, shown to the user (not to Claude). |
| `transport` | yes | `"stdio"`, or `"http"` for a server on 127.0.0.1 / localhost / [::1] only. |
| `command` | stdio | `npx`, `npm`, `uvx`, `uv`, `node`, `python`, `python3`, `py`, `deno`, `bun`, `docker`, `pipx`, an absolute path, or `./file` inside this folder. |
| `args` | no | Array of strings. |
| `cwd` | no | Folder relative to this tool's folder (default `.`). |
| `env` | no | `{"NAME": "value"}` for plain settings; `{"NAME": {"secret": true}}` for keys and tokens. |
| `url` | http | `http://127.0.0.1:<port>/mcp`. |
| `headers` | no | Like `env`; a secret header may have `"template": "Bearer {value}"`. |
| `start` | no | http only: `{"command": ..., "args": [...]}` that CMCP starts before connecting. |
| `capabilities` | yes | What the tool can do: any of `files`, `exec`, `python`, `network`, `gui`, `hardware`, `credentials`. State it honestly; the user sees it before turning the tool on. `[]` means none of these. |
| `version`, `homepage`, `license` | no | Shown to the user. `homepage` must be https. |
| `platforms` | no | `["win32", "darwin"]` (default: both). |
| `requires` | no | `[{"runtime": "uv"}, {"runtime": "app", "name": "Blender", "hint": "..."}]`, shown when something is missing. |
| `instructions` | no | At most 300 characters, appended to every tool description. |
| `lifecycle` | no | `on-demand` (default: stops after the idle time set in CMCP, 30 minutes unless changed) or `persistent`. |
| `timeouts` | no | `{"startMs": 1000-120000, "callMs": 1000-600000}` (defaults 30000 / 120000). |
| `maxConcurrency` | no | 1-16 calls at once (default 4); more wait in a queue. |
| `tools` | no | `{"include": [...], "exclude": [...], "descriptions": {"name": "shorter text"}}`. |

Placeholders in `env` values and `args`: `{data}` is a private folder for this tool in CMCP's
own data (never inside mcp-tools, so sharing the folder does not share the data); `{tool}` is
this tool's folder. Example: `"MEMORY_FILE_PATH": "{data}/memory.jsonl"`.

## 3. Names Claude sees

- The folder name is the tool id: `^[a-z][a-z0-9_]{0,19}$`, without `__`. Reserved:
  `cmcp`, `windows`, `mac`, `files`, `binary`, `blender`, `system`.
- Every tool of the server is exposed as `<id>__<tool>`, for example `freecad__make_box`.
- That part is at most 32 characters, because Claude adds `mcp__<connector>__` in front and
  the whole name must stay within 64. Longer names are shortened and get a 6-character hash.
- Prefer short ids (`freecad`, `gh`, `kicad`).

## 4. Writing an adapter when there is no MCP server

If a program only has a CLI, a socket or a Python API, write a small stdio MCP server here.
`_examples/hello-node/server.mjs` is a complete one with no dependencies (JSON-RPC lines on
stdin/stdout: answer `initialize`, `tools/list`, `tools/call`). In Python you may use the
official `mcp` package through `uvx`/`uv run`. Keep tool descriptions to one sentence that
says what happens on this computer.

## 5. Local test (one command)

Windows (installed CMCP; replace the folder):

```
"%CMCP%\app\runtime\node.exe" "%CMCP%\app\mcp-tools-cli.mjs" check "%CMCP%\mcp-tools\<id>"
```

Mac:

```
/Applications/CMCP.app/Contents/Resources/runtime/node /Applications/CMCP.app/Contents/Resources/app/mcp-tools-cli.mjs check ~/Library/Application\ Support/CMCP/mcp-tools/<id>
```

It validates the manifest, starts the server, lists its tools with the names Claude will
see, and stops it. Add `--call <tool> '<json arguments>'` to run one tool once. Exit code 0
means the tool is ready to be turned on.

## 6. Rules

1. Never write keys, tokens or passwords into this folder. Use `{"secret": true}`; the user
   enters the value in CMCP, which keeps it in the system keychain or Windows DPAPI.
2. Pin versions (`pkg@1.2.3`, `pkg==1.2.3`). Do not use `@latest`.
3. Declare `capabilities` honestly.
4. Do not download or copy third-party binaries into this folder; let npx/uvx/docker fetch
   them from their official sources. Link to the project in `homepage`.
5. HTTP servers listen on 127.0.0.1 only. Remote MCP servers belong on the VPS itself.
6. Do not change anything outside your own tool folder, and never edit CMCP's files.
7. Do not install runtimes silently. If Node.js, uv or Python is missing, tell the user.

## 7. Not supported yet (interface 1)

Prompts, resources, sampling and elicitation (questions during a call; the server gets a
"not supported" error), remote URLs, SSE. Only tools are forwarded.

## 8. Submitting a preset to the CMCP market

A preset is a reviewed tool that every CMCP user can install with one click from
Settings > Market. Presets live in the CMCP repository as `app/mcp-presets/<id>.json`:

```json
{
  "schema": 1,
  "id": "fetch",
  "category": "web",
  "title": {"zh": "从本机抓取网页", "en": "Fetch pages from this computer"},
  "summary": {"zh": "一句话说明（不超过 200 字）", "en": "One sentence (at most 200 characters)"},
  "detect": [],
  "minCmcp": "4.21.0",
  "manifest": { "...": "a complete cmcp-tool.json, see section 2" }
}
```

Rules, checked by CI (`node app/mcp-tools-cli.mjs presets-check --online`):
1. The manifest runs a published package pinned to one exact version: `npx` with
   `package@1.2.3`, `uvx` with `package==1.2.3`, or `docker` with `image:tag` (not `latest`)
   or `image@sha256:...`. `manifest.version` equals the pinned version, and that version must
   exist on npm or PyPI.
2. `license`, an https `homepage` (the project, not a mirror) and honest `capabilities` are
   required. No key or token values; use `{"secret": true}`.
3. `title` and `summary` in Chinese and English. `category`: 3d, browser, web, memory,
   developer, design, data or other. `detect` may list `blender` or `chrome` when the tool
   needs that program; the market then shows whether it is installed.
4. Do not add `manifest.preset`; CMCP writes it on install.
5. Only link to the project. Never copy its code or binaries into the CMCP repository.

To submit: fork the repository, add the file, run the check above, and open a pull request
that says what the server does on the user's computer and why the version is trustworthy
(maintainer, release notes). A maintainer reviews the source of that exact version before
merging. A new version is a pull request that changes the pin; users then see
"Update to x.y.z" and confirm it themselves. CMCP never updates a tool by itself.

## 9. Compatibility: interface 1 and later versions

- `schema: 1` stays valid for as long as CMCP supports interface 1. New optional fields are
  added to schema 1; older CMCP versions show them as unknown-field warnings and ignore them.
- A change that would make an old manifest mean something else gets a new `schema` number.
  CMCP then reads both the new and the previous schema for at least one major version, and
  refuses newer schemas with "needs a newer CMCP" instead of guessing.
- Presets that need a newer CMCP set `minCmcp`; older CMCP versions show them as unavailable.
- Tool names (`<id>__<tool>`) and placeholders keep their meaning across versions.

## 10. Sharing

Zip the tool folder. The receiver puts it into their own mcp-tools folder, turns it on in
CMCP and confirms it. Secrets are not part of the folder and must be entered again.

CMCP rewrites this file on updates only if it is unchanged; otherwise the new version is
saved as `AGENT.cmcp-new.md`.
