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
- **SSH 登录**：一键打开你选定的终端并连上 VPS，支持密码和公钥。一台设备可以只有 SSH、只有共享网页登录，或两者都有。SSH 只负责打开终端，不走 MCP 连接。目前仅 Windows。
- **个性化设置**：支持明暗主题、简体中文与 English。
- **桌面集成**：支持系统托盘（macOS 上是菜单栏）、开机自启、桌面快捷方式和应用更新。

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
