<div align="center">

<img src="../app/assets/cmcp-icon-1024.png" alt="CMCP 图标" width="128" height="128" />

# CMCP

### 让云电脑上的 Claude 使用这台电脑的文件、命令和桌面

**用一个卡片式桌面应用管理所有云电脑：连接互相独立，断线自动恢复，登录省心。**

[![Version](https://img.shields.io/github/v/release/isAlexYoung/cmcp?color=blue&label=version)](https://github.com/isAlexYoung/cmcp/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)](https://github.com/isAlexYoung/cmcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)
[![Downloads](https://img.shields.io/github/downloads/isAlexYoung/cmcp/total)](https://github.com/isAlexYoung/cmcp/releases/latest)

[English](README.md) | 中文 | [更新日志](https://github.com/isAlexYoung/cmcp/releases)

**[下载](#下载) · [快速开始](#快速开始) · [主要功能](#主要功能) · [常见问题](#常见问题) · [许可证](#许可证)**

</div>

## 下载

从 [Releases](https://github.com/isAlexYoung/cmcp/releases/latest) 下载最新版。每个安装包都有对应的 `.sha256` 校验文件。

| 平台 | 安装包 |
|---|---|
| Windows x64，安装向导（推荐） | `CMCP-<版本号>-windows-x64-setup.exe` |
| Windows x64，便携版 | `CMCP-<版本号>-windows-x64.zip` |
| macOS，Apple 芯片 | `CMCP-<版本号>-macos-arm64.dmg` |
| macOS，Intel 芯片 | `CMCP-<版本号>-macos-x64.dmg` |

同名的 macOS `.zip` 文件供应用内更新使用，安装时请下载 `.dmg`。

## 快速开始

你需要一台能通过 HTTPS 地址访问、并已安装 Claude 的云电脑。

**Windows**

1. 运行安装程序，选择安装目录、快捷方式和是否开机启动，不需要管理员权限。安装程序暂未签名，如果 Windows 提示“已保护你的电脑”，点击 **更多信息 → 仍要运行**。使用便携版时，把压缩包完整解压到一个文件夹，再运行 `CMCP.exe`。
2. 打开 CMCP。
3. 点击 **添加设备**，输入它的地址。
4. 启动连接，按提示登录云电脑。
5. 添加新的云电脑后，完全退出并重新打开云电脑上的 Claude。

现在，云电脑上的 Claude 就能使用这台电脑的工具了。

**macOS**

1. 打开 `.dmg`，把 `CMCP.app` 拖到“应用程序”文件夹。
2. 从“应用程序”打开 CMCP，然后按上面的第 3 到第 5 步操作。

应用使用临时签名，没有经过 Apple 公证，所以首次打开时 macOS 会阻止它。按你的系统版本放行一次即可：

- **macOS 15 及以上**：在提示框里点 **完成**，再打开 **系统设置 → 隐私与安全性**，在页面下方找到 CMCP，点击 **仍要打开** 并确认。
- **macOS 13 和 14**：在“应用程序”里按住 Control 点击 CMCP，选择 **打开**，再在提示框里点 **打开**。
- **提示“已损坏，无法打开”**：这是下载隔离标记造成的。确认安装包的 `.sha256` 校验无误后，在“终端”运行下面的命令，再打开 CMCP：

```bash
xattr -dr com.apple.quarantine /Applications/CMCP.app
```

## 主要功能

- **独立连接管理**：每台云电脑可以分别启动和停止。
- **卡片式界面**：支持自定义名称与图标、拖动排序和折叠详情。
- **连接恢复保护**：断线后支持重连、请求等待、执行结果查询与去重。
- **便捷登录**：支持共享网页登录，以及加密保存密码和自动登录。
- **SSH 登录**：一键打开你选定的终端并连上 VPS，支持密码和公钥。一台设备可以只有 SSH、只有共享网页登录，或两者都有。打开终端时会先为这台设备建立后台 SSH 通道，MCP 连接走这条通道；你看到的终端是另一个独立的 SSH 会话。
- **断开后关闭窗口**：在 设置 → 连接 里选择打开共享网页的浏览器和 SSH 使用的终端，下拉框显示各自的应用图标。还可以在断开连接时关闭这台设备的网页（需选择 Edge、Chrome 或 Firefox，网页会在单独的窗口里打开，需要在里面登录一次）和终端窗口。两项默认关闭。
- **个性化设置**：支持明暗主题、简体中文与 English。
- **桌面集成**：支持系统托盘（macOS 上是菜单栏）、开机自启、桌面快捷方式和应用更新。

## 用 VPS 上的 Claude 控制本机 Blender

本机安装并启用 [MCP for Blender 插件](https://github.com/ahujasid/mcp-for-blender)，打开 Blender，在侧栏中启动插件服务。CMCP 默认连接 `127.0.0.1:9876`；插件改了端口时，让 Claude 在 Blender 工具的 `port` 参数中填写对应端口。

从 4.20 起 Blender 工具默认关闭：在 设置 →“工具”中打开 Blender（CMCP 检测到 Blender 时也会提示一次）。连接 CMCP 后重新打开 VPS 上的 Claude，即可让它使用 `blender_*` 工具读取当前场景、检查物体、执行 Blender Python，以及获取视口图片。Windows 和 Mac 使用同一套接口；网页桌面、CloudCLI 与 SSH 终端沿用各自现有的 MCP 通道，无需开放 Blender 的公网端口，也不需要另外启动 `uvx` 服务。

例如：“通过 CMCP 检查我本机 Blender 的连接，读取当前场景，然后创建一个红色立方体，给我看视口截图。先不要覆盖已有文件。”

`blender_execute_code` 会立即返回任务编号，Claude 应在同一个 MCP 连接器中调用 `blender_job_status` 查询结果，再继续下一步。脚本等待上限默认 120 秒，可通过 `timeout_ms` 调整，最长 10 分钟。超时或断线不代表 Blender 已停止执行；CMCP 不会自动重复执行修改操作，应先检查场景。退出 CMCP 后任务记录不保留，也不会强制停止 Blender 中已经提交的代码。

此集成直接兼容插件的本机接口，提供场景、物体、Python、视口与任务查询工具；不是将第三方 MCP 服务的全部工具直接导入。素材平台搜索、在线生成与第三方服务端的安全模式不包含在此适配器内。未启动 Blender 时，仅 Blender 工具提示如何连接，其余 MCP 工具正常使用。

## 本机 MCP 工具与工具市场

设置 →“工具”可以为这台电脑开关 CMCP 的内置工具组：文件读写、命令执行、后台任务、开发工具链、桌面操作、Blender。Blender 默认关闭。

CMCP 还可以在这台电脑上运行其他 MCP 服务器，把它们的工具交给 VPS 上的 Claude：

- **市场**（设置 →“市场”）：经过审核的预设，例如 Blender、Playwright、Chrome 开发者工具、长期记忆、网页抓取。每个预设固定一个版本，只包含配置和项目链接；第一次启动时由 `npx` 或 `uvx` 从官方源下载。安装后默认关闭。有新版本时会显示“更新到 x.y.z”，你确认后才会更新。
- **粘贴配置**：设置 →“工具”→“添加”，粘贴 MCP 服务器 README 里给 Claude Desktop 的 `mcpServers` 配置即可。
- **自己编写**：每个工具是 `mcp-tools` 文件夹（Windows 在 `user` 旁边，Mac 在 `~/Library/Application Support/CMCP/mcp-tools`）里的一个子文件夹，内含 `cmcp-tool.json`。该文件夹里的 `AGENT.md` 写明了格式和一条命令的测试方法，供人和 AI 编程助手参考。

Claude 看到的工具名是“文件夹名__工具名”，例如 `blender_mcp__get_scene_info`。CMCP 只使用电脑上已有的 Node.js、uv、Python 或 Docker，缺少时会提示。令牌和密钥保存在系统钥匙串或 Windows 加密存储里，不会写进文件夹。更新或卸载 CMCP 都会保留 `mcp-tools`。

**提交预设**：新增 `app/mcp-presets/<id>.json`（固定软件包版本）并发起 Pull Request。规则和 CI 的检查方法见 `app/mcp-tools-template/AGENT.md` 第 8 节。

## 常见问题

**提示便携包不完整怎么办？**

有文件没有解压出来。把压缩包重新完整解压到一个新文件夹，再从那里运行 `CMCP.exe`。

**云电脑上的 Claude 看不到工具？**

完全退出并重新打开云电脑上的 Claude。新增的配置只在 Claude 启动时加载。

**关闭窗口后会怎样？**

取决于 **设置 → 通用 → 关闭时最小化到托盘**（macOS 上是 **关闭时最小化到菜单栏**）。开启时保留已连接的设备；关闭后，关闭窗口会退出并断开全部连接。

**怎么更新？**

打开 **设置 → 关于 → 检查更新**，CMCP 会自动下载并校验更新。在 macOS 上，如果新版本启动失败，会自动回到原来的版本。更新需要修改 CMCP 所在文件夹的权限，所以装在“应用程序”时请用管理员账户更新。临时签名的应用更新后，macOS 可能要求你重新授予辅助功能等权限。

**怎么卸载？**

在 Windows 上打开 **设置 → 关于 → 卸载 CMCP**，用安装向导安装的版本也可以从系统的“已安装的应用”里卸载。它会断开全部连接，尽可能移除云电脑上的 Claude 配置，并删除本机保存的地址、密码和设置。安装版会同时删除程序文件和快捷方式；便携版请之后手动删除程序文件夹和桌面快捷方式。

在 macOS 上打开 **设置 → 关于 → 卸载 CMCP**。它同样会断开全部连接，尽可能移除云电脑上的 Claude 配置，并删除应用、`~/Library/Application Support/CMCP` 里的数据、钥匙串中保存的密码和登录项。云电脑未连接又没有保存密码时无法移除它上面的配置，CMCP 会告诉你有几台未移除。如果已经把应用拖进废纸篓，可以运行下面的命令删除数据，再到“钥匙串访问”中删除名为 `CMCP Mac cloud password` 的项目：

```bash
rm -rf ~/Library/Application\ Support/CMCP
```

**日志在哪里？**

打开 **设置 → 关于 → 日志文件夹**。在 Windows 上，错误会写入程序文件夹里的 `user\error.log`。在 macOS 上，日志和设置都保存在 `~/Library/Application Support/CMCP`。

**CMCP 是 Anthropic 的产品吗？**

不是。CMCP 是独立工具，与 Anthropic 没有官方隶属关系。

## 许可证

代码采用 [MIT 许可证](../LICENSE)。内置的第三方组件保留各自的许可证，详见[第三方声明](../THIRD_PARTY_NOTICES.txt)。

### 应用图标

CMCP 图标是为本项目创作的原创图标，版权归 CMCP 所有（© 2026 CMCP），保留所有权利，**不适用** MIT 许可证。

图标只能用于指代 CMCP，或作为未经修改的 CMCP 安装包的一部分使用。未经书面许可，不得商用、修改，也不得用于其他产品或服务。分支项目和衍生产品必须更换图标。详见[完整声明](../THIRD_PARTY_NOTICES.txt)。
