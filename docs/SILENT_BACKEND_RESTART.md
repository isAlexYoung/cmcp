# 打开管理界面时静默重启后台

基线 `3df802cc1363f99a91aa3a6807206f9ccc98b5e1`，开发分支 `codex/ui-card-dashboard`，仍为未发布的 4.0.0。用户明确要求每次打开 EXE 重启后台，替代此前只提示手动切换的行为。受测完整 SHA 由 CI environment.json、GitHub Actions head_sha 及便携包 app/build-info.json 对应。

## 行为

只有正式 EXE 的无参数启动触发：使用隐藏、非交互 PowerShell 子进程，先验证运行文件及连接开关，再复用 Stop-LinkService / Start-LinkService；确认新 PID 对应当前目录的 server.mjs，且同时支持逐台控制及自动登录。没有重用会改变全部启停状态的 start.ps1 / stop.ps1 入口。后台生命周期锁按本机账户状态目录区分，多次打开串行重启；现有后台的单实例管道及 supervisor mutex 保持不变。

重启发生在界面实例判断之前，所以重复双击也会重启；已有窗口保留，重复启动进程静默退出。没有重启确认、进度、成功或失败弹窗。后台文件不完整或开关损坏时先拒绝，避免停止健康旧后台；无法停止旧进程时不叠加启动。其他异常写固定本机错误日志，不转发密码、原始服务异常或上游正文，不请求管理员权限。

保存的密码、配置、备注、图标、启停开关及修订号保持原样；不设置或撤销开机启动，不下载、不构建、不运行远端命令。后台本身会启动，但从未启用和已停止的云电脑仍保持停止。已启用目标恢复原连接流程；共享网关会话只在旧进程内存中，不能跨重启保留，须从新入口打开网页。自动登录开关、一次尝试及双重认证规则不变。已有云端桌面进程及文件不因本机后台重启而被关闭或删除。

关闭管理窗口继续保留后台。安全预览 EXE、--demo、--preview、--preview-shortcut、--self-test 均不调用真实重启。先前的桌面快捷方式询问仍为独立的首次界面行为，不属于后台重启提示。

## 验证与证据

本机 Windows / Windows PowerShell 5.1 / Node v22.23.3：

| 类别 | Passed | Failed | Skipped |
|---|---:|---:|---:|
| WinForms、真实隐藏子进程及原界面检查 | 116 | 0 | 0 |
| 原 Node 认证、断线、独立目标、自动登录 | 40 | 0 | 0 |
| 原目标开关 | 20 | 0 | 0 |
| 原编辑删除 | 19 | 0 | 0 |
| 原页内操作及取消 | 27 | 0 | 0 |
| 原 DPAPI 自动密码保存 | 18 | 0 | 0 |
| 独立真实 Node / supervisor 重启 | 15 | 0 | 0 |
| 真实隔离 Chrome 自动登录 | 10 | 0 | 0 |
| 合计 | 265 | 0 | 0 |

重启专项 `app/tests/manager-restart.test.ps1` 使用唯一临时目录、独立 supervisor mutex、仅匹配该临时目录的进程枚举，以及不联网的 Node 状态桩。执行生产重启入口、生命周期锁、实际进程停止和启动；未使用个人配置或既有后台。测试覆盖旧版切换、新 PID、重复打开、两进程同时启动后仅留一份 Node、保存文件字节不变、A 启用 B 停止、全部停止后的重开、损坏开关及缺文件的停止前拒绝、输出无弹窗提示。真实隐藏 GUI worker 测试还验证中文及单引号路径、stdout / stderr 大量输出不阻塞、失败退出与缺入口的静默返回。

本机原始证据：build-results/restart-ui.json、restart-worker-final/restart.json 及各子进程 out/err；其他回归见 restart-node.tap、restart-controls.json、restart-targets.json、restart-inline.json、restart-save.json、restart-browser/browser.json。另验证已存在但空的 config.json 在停进程前被拒绝，不会重新生成 token。CI 保留 JSON、原日志、界面截图、环境记录及便携包。

夹具初版曾使用被 PowerShell 默认别名遮蔽的 Write 函数，改为 Put-File；第二版读取重定向进程退出码前未保留 Handle，错误地把空退出码判为失败（restart-worker-second/restart.json，0/1）。修正测试进程观测后，生产断言保持不变，第三版 14/0。历史自动登录首轮 CI 超时证据仍保留于 SHARED_AUTO_LOGIN.md，不因本轮覆盖。

未执行真实 VPS、当前个人后台的实际重启、跨 Windows 用户及管理员权限不匹配矩阵；不能把私有夹具成功当成这些环境已验收。本轮不替用户打开正式无参数 EXE，不改旧安装目录，不触碰 VPS。下一次用户打开新版 EXE 时才按新行为重启后台。
