# CMCP

让独立云电脑中的 Claude 使用本机 Windows 的文件、命令与桌面工具。**4.0.1** 提供卡片式界面、明暗主题和独立的多台云电脑连接。设置和更新功能留待 4.1.0 实现。

本项目为独立工具，与 Anthropic 无官方隶属关系。

## 下载与使用

从 [Releases](https://github.com/isAlexYoung/cmcp/releases) 下载 `CMCP-4.0.1-windows-x64.zip`，完整解压后打开 `Claude-MCP.exe`。不要只复制 EXE，不要把 GitHub 的 Source code 压缩包当作可运行便携包。

支持具备 Windows PowerShell 5.1、.NET Framework 4.x 的 Windows 10/11 x64。发布包内置 Node.js 和 Node 依赖，不会自动下载或安装缺少的依赖。

桌面尚无有效 CMCP 快捷方式且未勾选“不再提示”时，打开程序会询问是否创建名为 **Claude-MCP** 的快捷方式。已有有效快捷方式时，即使未勾选也不会询问，不会自动修改原快捷方式。快捷方式使用内置的 Claude Desktop 图标，新电脑不需要安装 Claude Desktop。

主界面以卡片管理云电脑，支持备注、图标、拖动排序及折叠详情。添加地址后启动对应卡片，再通过“打开云电脑”完成共享网页登录；可选择使用 Windows 加密保存密码并自动登录。卡片启停只作用于对应 VPS；多台独立 VPS 可同时连接本机。每次打开正式 EXE 会静默重启后台，短暂断开全部 MCP 连接，保留各台启停状态；共享网页登录会话需要从新入口恢复。关闭界面保留后台。原有 BAT 入口仍为批量启停。

连接后，远端 Claude 可按当前 Windows 账户权限读写允许的文件、运行命令和操作桌面。请只连接自己信任的云电脑；这是实际工具权限，不是只读预览。

配置、密码保护数据和日志保存在当前用户的 `%LOCALAPPDATA%\ClaudeLocalMcp`，不包含在发布包或源码仓库中。详细使用步骤见 [桌面版使用说明](../docs/桌面版使用说明.md)。

## 源码构建

源码仓库不提交已编译 EXE、Node 可执行文件和 `node_modules`。开发环境需要 Node.js 22（发布基线 22.23.3）、npm、Windows 自带 .NET Framework C# 编译器。依赖以 `app/package-lock.json` 固定。

在仓库目录安装开发依赖：

```powershell
npm --prefix app ci
```

编译中文界面（包括内置图标）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\build-manager.ps1
```

生成完整便携包前，需要把匹配的官方 Node.js x64 `node.exe` 放入 `app\runtime`，保留其 LICENSE，再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\package-manager.ps1
```

构建输出默认位于仓库父目录的 `release`。已存在的版本拒绝覆盖。GitHub Actions 会安装固定 Node、检查锁文件依赖、编译、自检、测试并提供构建 Artifact；应用运行时不会执行这些开发安装操作。

## 测试

```powershell
node --test app\tests\reconnect.test.mjs app\tests\shared-session.test.mjs app\tests\terminal-link.test.mjs app\tests\target-connections.test.mjs
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\app\tests\target-controls.test.ps1
```

编译后运行 `Claude-MCP.exe --self-test <输出 JSON 路径>`，测试使用独立临时目录；不会在真实桌面创建快捷方式、修改用户连接或访问真实 VPS。

第三方图标、Node.js 与依赖授权见 [THIRD_PARTY_NOTICES](../docs/THIRD_PARTY_NOTICES.md)。设置和更新入口暂时禁用。界面布局参考 [CC Switch](https://github.com/farion1231/cc-switch)，使用原生 WinForms 实现；真实 React 仅用于隔离的自动登录回归夹具，不属于运行依赖，也不包含在发布包内。
