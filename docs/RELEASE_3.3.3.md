# CMCP 3.3.3

新增功能：正常启动 EXE 时，主界面前询问是否创建桌面快捷方式；按钮为“是”“否”，提供“下次不再提示”。快捷方式固定名称 `Claude-MCP`，使用内置 Claude Desktop 原始图标，不依赖用户安装 Claude Desktop。只创建当前用户的快捷方式，不提权、不启动 MCP 连接。

“否＋勾选”也记住选择；未勾选则下次继续询问。图标同时用于 EXE 和管理窗口。提示偏好与认证配置分开保存，创建失败不抑制后续重试；非本程序的同名快捷方式保留。使用原生 Unicode Shell 接口，覆盖中文、空格及单引号路径。

保留 3.3.2-ui3 的多 VPS 独立启停、共享网页登录、双重认证及取消处理。没有增加设置按钮，也没有开展 4.x.x UI 重构。没有调整本机文件和工具权限，没有自动下载依赖，没有部署或修改真实 VPS。

## 验证范围

- EXE 32 项：原有 18 项与新增 14 项，包含真实 WinForms 按钮交互、实际 Shell `.lnk` 写入／读回和冲突保护。测试只写随机临时目录。
- Node 30 项：认证、重连、兼容终端、两台独立模拟 VPS，以及真实本机后台子进程。
- Windows PowerShell 5.1 20 项：逐台控制、并发写入、旧后台拒绝及生产脚本分支。
- 共 82 passed / 0 failed / 0 skipped；真实 VPS 联机、已有生产状态、用户手动验收 3 项 not_executed。未在全新 Windows 虚拟机验收。
- 官方 Node.js 22.23.3 `win-x64/node.exe` SHA256 与分发清单一致：`9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e`。

开发时曾发现脚本快捷方式接口对测试中文路径返回 E_INVALIDARG，已改为原生 `IShellLinkW`／`IPersistFile`，保留中文路径断言；早期失败不计作通过。接口参考：[Microsoft IShellLinkW](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw)。

公开仓库为 `isAlexYoung/cmcp`。运行包名 `CMCP-3.3.3-windows-x64.zip`，独立 `.sha256` 文件提供完整性校验。源码仓库排除 Node 可执行文件、已安装依赖、构建 EXE 与所有个人连接配置；可运行的完整文件夹通过 GitHub Release 分发。Node 与依赖授权、Claude 图标归属见 `THIRD_PARTY_NOTICES.md`。
