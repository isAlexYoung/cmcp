# CMCP

让独立云电脑中的 Claude 使用本机 Windows 的文件、命令与桌面工具。**4.1.1** 提供卡片式界面、独立的多台云电脑连接、中英文设置、托盘和 Windows 更新，并增加短暂断线时的请求等待、结果查询与去重保护。

本项目为独立工具，与 Anthropic 无官方隶属关系。

## 下载与使用

从 [Releases](https://github.com/isAlexYoung/cmcp/releases) 下载 `CMCP-4.1.1-windows-x64.zip`，完整解压后打开 `Claude-MCP.exe`。不要只复制 EXE，不要把 GitHub 的 Source code 压缩包当作可运行便携包。

支持具备 Windows PowerShell 5.1、.NET Framework 4.x 的 Windows 10/11 x64。发布包内置 Node.js 和 Node 依赖，不会自动下载或安装缺少的依赖。

桌面尚无有效 CMCP 快捷方式且未勾选“不再提示”时，打开程序会询问是否创建名为 **Claude-MCP** 的快捷方式。已有有效快捷方式时，即使未勾选也不会询问，不会自动修改原快捷方式。快捷方式使用内置的 Claude Desktop 图标，新电脑不需要安装 Claude Desktop。

主界面以卡片管理云电脑，支持备注、图标、拖动排序及折叠详情。添加地址后启动对应卡片，再通过“打开云电脑”完成共享网页登录；可选择使用 Windows 加密保存密码并自动登录。卡片启停只作用于对应 VPS；多台独立 VPS 可同时连接本机。每次打开正式 EXE 会静默重启后台，短暂断开全部 MCP 连接，保留各台启停状态；共享网页登录会话需要从新入口恢复。默认关闭窗口隐藏到托盘、保留连接；明确退出程序会断开全部连接并停止后台。原有 BAT 入口仍为批量启停。

连接后，远端 Claude 可按当前 Windows 账户权限读写允许的文件、运行命令和操作桌面。请只连接自己信任的云电脑；这是实际工具权限，不是只读预览。

配置、密码保护数据和日志保存在当前用户的 `%LOCALAPPDATA%\ClaudeLocalMcp`，不包含在发布包或源码仓库中。

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

第三方图标、Node.js 与依赖授权见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.txt)。设置页包含简体中文 / English、浅色 / 深色 / 跟随系统、开机自启、直接退出程序或隐藏到系统托盘，以及桌面快捷方式。所有列表和表单隐藏原生滚动条，保留滚轮和键盘滚动。

更新按钮悬停时检查 GitHub 最新稳定 Release；点击后只选择 `windows-x64` 包，校验 SHA-256 和安装文件清单后准备替换并重新启动。失败时恢复旧便携包，备份保留在同级 `.cmcp-backup-*` 目录。密码、连接配置和日志位于用户目录，不参与程序替换。源码工作区、有额外文件或已修改程序的目录不会自动覆盖，需手动下载完整便携包。4.0.1 及更早版本首次升级请手动下载最新便携包。界面布局参考 [CC Switch](https://github.com/farion1231/cc-switch)，使用原生 WinForms 实现；真实 React 仅用于隔离的自动登录回归夹具，不属于运行依赖，也不包含在发布包内。

4.1.1 在确认请求未送达时最多等待 30 秒。新版兼容中继可在重连后查询原请求结果，避免自动重复执行。结果仅按目标与会话在后台内存保留 10 分钟，单台最多 256 条、64 MiB；后台重启或结果无法确认时会明确提示未知，不自动重放。旧接口若不支持结果查询，执行中断时只会保守提示结果未知。首次升级连接后，请按配置提示重新打开云端 Claude，以加载新版连接器。
