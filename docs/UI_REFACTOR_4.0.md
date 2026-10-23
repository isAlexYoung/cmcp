# CMCP 4.0.0 卡片界面开发说明

本轮在 `F:\CMCP` 的 `codex/ui-card-dashboard` 开发，不替换正在使用的旧目录，不发布新的稳定版或更新真实 VPS。公开稳定 Release 仍是 v3.3.3。

## 布局与实现

参考用户提供的 CC Switch 截图及其 [ProviderCard](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/ProviderCard.tsx) 信息层级。该项目的 React/Tauri 组件不能直接用于现有 WinForms；本轮只借鉴布局，所有控件在现有原生框架内实现，没有引入运行依赖或复制 CC Switch 源码。

- 72px 顶部工具栏：应用名、禁用的设置与更新入口、主题按钮、添加按钮。
- 纵向卡片：圆角 15px、细边框、14px 间距；蓝色浅底表示选中。
- 默认显示地址和真实后台状态；悬停或键盘聚焦才出现操作按钮。灰色未连接、连接中、蓝色成功连接；点击状态按钮启动或确认停止对应目标。
- 详情在卡片内部展开，嵌套面板显示连接状态、登录方式、真实诊断说明和对应操作。没有伪造 CPU、流量等现有后台未提供的指标。
- 小于 760px 的卡片使用两行标题区，为操作留出独立一行；列表自然增长并纵向滚动。实测窗口客户区 660×500、800×600、1100×720、1440×850。
- 折叠使用有界的短动画，无额外网络请求；后台轮询保留选中、展开及滚动位置。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `tools/desktop-ui/Manager.cs` | 保留既有状态读取和固定动作分派，程序入口、自检、截图入口 |
| `tools/desktop-ui/Dashboard.cs` | 卡片列表、操作接线、目标独立性、排序、主题 |
| `tools/desktop-ui/DashboardControls.cs` | 统一颜色／间距变量，工具栏、图标按钮、卡片、详情、编辑窗口 |
| `tools/desktop-ui/UiPreferences.cs` | 有界的备注、图标、主题、排序保存；原子替换、账户目录互斥锁 |
| `tools/desktop-ui/DashboardTests.cs` | 真实 WinForms 控件及偏好回归 |
| `app/manager-targets.ps1` | 复用原互斥锁／原子写入的地址编辑与删除；必须停止后提交 |
| `app/remove-cloudpc.ps1` | 先运行原逐台停止入口，确认成功后才删除对应配置 |
| `app/add-cloudpc.ps1` / `app/ui.ps1` | 复用验证向导，增加目标 ID 与可编辑地址预填参数 |
| `app/tests/manager-targets.test.ps1` | 编辑、删除、并发状态重校验、DPAPI、其他目标保留检查 |
| `tools/build-manager.ps1` | 原生编译正式 EXE，或额外编译完全隔离的预览 EXE |
| `tools/package-manager.ps1` | 校验新组件完整性；预览 EXE 不进入正式便携包 |
| `.github/workflows/validate.yml` | 加入新界面、编辑删除检查及三种截图证据 |
| `app/package.json` / lock、`app/common.ps1`、`app/cloudpc-connector.py` | 版本统一为 4.0.0；依赖和连接协议不变 |
| `.gitignore`、README、使用说明 | 排除预览产物／个人偏好，说明新交互与开发状态 |

## 数据与安全

备注与图标不是连接身份。原 `cloudpc-targets.json` 的 name、DPAPI 凭据、target-controls 开关、Cookie/Session 和后台机制均沿用。显示排序不改源连接列表，备注允许相同但内部 ID 不变。

新 `dashboard-preferences.json` 只包含显示偏好，最多 100 条、4 MiB，每张图标最多 32768 个 base64 字符。选取图片时限制 1 MiB、2048px，保存为 72px PNG，不保存路径，不请求远程图标。不读取该文件之外的未知界面配置；损坏文件不覆盖。主题变化和卡片排序不触发 VPS 登录。

编辑地址要求该台开关禁用且运行中的后台没有报告它仍活跃；保存前持原锁再次检查，并拒绝与其他目标重复的 URL。取消验证不更改原地址。删除先用既有 `stop.ps1 -TargetName`，超时／失败保留原配置；删除提交前再次检查目标开关和后台状态，不终止共享服务，不改其他目标开关。确认后删除本地配置，不删除服务器或用户文件。

## 已执行的本机验证

环境：Windows，Windows PowerShell 5.1，.NET Framework 4.x 编译器，固定 Node v22.23.3。所有测试使用独立临时状态目录、临时桌面或本机模拟云端。

| 类别 | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| WinForms / 快捷方式 / 显示偏好 / 布局与交互 | 68 | 0 | 0 |
| 原逐台开关 PowerShell 回归 | 20 | 0 | 0 |
| 新地址编辑／删除安全测试 | 19 | 0 | 0 |
| 认证、重连、逐台连接及真实后台子进程（本机模拟云端） | 30 | 0 | 0 |
| 合计 | 137 | 0 | 0 |

上述是本机结果。远程 CI 结果以该分支实际 Actions 运行记录为准，不提前记为成功。正式编译、预览编译及 PowerShell 解析另按命令退出码检查，不混入用例数。

首次使用本机系统 Node v24.15.0 运行旧连接测试时发生 `EPERM rename target-controls.json.tmp`，该轮退出 1，没有完整 TAP 汇总。原始输出保留在 `build-results/node-node24-attempt.tap`，不能计作成功。之后使用项目已经固定的 v22.23.3 完整运行 30/0/0；未修改生产连接代码或放宽测试断言。不能仅凭这次对照断定 Node 24 是唯一原因。

单行复现命令（从 F:\CMCP 运行）：

- 正式编译：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\build-manager.ps1`
- 预览编译：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\build-manager.ps1 -PreviewOnly`
- 界面检查：`.\Claude-MCP.exe --self-test F:\CMCP\build-results\manager.json`
- 原开关：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File app\tests\target-controls.test.ps1`
- 编辑删除：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File app\tests\manager-targets.test.ps1`
- 连接回归：`.\app\runtime\node.exe --test app/tests/reconnect.test.mjs app/tests/shared-session.test.mjs app/tests/terminal-link.test.mjs app/tests/target-connections.test.mjs`

截图在 `build-results/light.png`、`dark.png`、`narrow.png`，原始结果在 `manager.json`、`target-controls.json`、`manager-targets.json`、`node.tap`。CI 上传对应测试结果与截图，不跟踪机器输出和个人配置。

## 未执行与已知边界

- 未操作真实 VPS、真实用户连接状态或用户手工流程；自动化不能替代真实云端联机验收。
- 未完成物理鼠标拖动、辅助技术及多显示器高 DPI 人工验收；已测真实控件、键盘焦点、排序路径、四种客户区尺寸、30 卡片滚动和两种主题。
- 设置／更新是有意禁用的预留入口，没有自动更新功能。
- 复制按钮复制地址，不克隆包含凭据的目标。新建目标依旧使用原安全验证向导。
- 正式 EXE 仍需要完整的 app 与运行依赖；预览 EXE 只验证界面，点击连接使用示例状态，不具备真实连接能力。
- 暂不发布 v4.0.0 标签／Release，先让用户审查界面。旧 v3.3.3 安装目录和已运行进程不改动。


## 本轮反馈调整：标题、悬停、尺寸与页内编辑

后续修改只涉及原生界面、编译清单、对应测试与文档；没有变更连接协议、认证、Linux/VPS 或运行中的旧目录。

- 系统窗口标题与工具栏名称均为 `CMCP`，不显示版本号。
- 主页面底部说明、日志／使用说明／程序文件夹链接全部移除；不添加设置页面。
- 卡片使用独立状态 Label；鼠标离开即显示已停止／已连接，处于真实连接或停止过程时显示对应进行中状态。鼠标移入显示状态按钮、编辑、复制、删除及展开按钮。保留键盘 Tab 导航的可用性。
- 删除 90ms 悬停轮询，改用卡片与子控件的指针／焦点事件；单独处理鼠标与键盘的焦点来源，避免点击后保留错误的悬停状态。状态刷新不再依赖等待下一轮轮询恢复文字。
- 常规卡片高度从 96px 增至 116px；窄卡片为 156px。正文从 9pt 增至 11pt，连接按钮 136×40、图标按钮 36×40，间距 16px。工具栏保持紧凑。
- 按钮不再绘制虚线焦点框，键盘焦点可使用柔和实线轮廓。
- `TargetEditorPage.cs` 是主窗口内嵌 UserControl，左上返回、右下保存；返回丢弃未保存修改并保留列表状态。没有打开编辑 Form 或嵌套对话框。选取图标仍使用 Windows 文件选择器；地址改动保存后沿用原安全验证向导。
- `NativeFrame.cs` 通过 Windows DWM 的单窗口设置同步深色标题栏和文字颜色，浅色时恢复系统默认，不修改全局主题或注册表。接口依据：[Microsoft DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)。Win11 本机自动测试的深／浅色 caption 设置均返回 `0`；这表明系统接受设置，不等于完成原生标题栏像素验收。`DrawToBitmap` 不完整呈现 DWM 非客户区，实际显示仍待用户打开新版确认。旧系统不支持的属性按 HRESULT 保留证据，不阻止程序启动。

新增源码：`TargetCard.cs`、`TargetEditorPage.cs`、`NativeFrame.cs`。原 TargetEditor Form 已移除。主窗口生命周期、真实后台读取、逐台启动／停止／编辑地址／删除的安全边界不变。

本轮桌面测试为 **83 passed / 0 failed / 0 skipped**，原 Node / PowerShell 回归由同一 CI 重新执行；若全部通过，总数为 152（83+30+20+19），应以实际 CI 记录为准。新增检查覆盖悬停离开、刚连接后的状态恢复、进行中状态、反复切换、页面返回、保存、无效地址拦截和两种编辑页尺寸。尚未操作真实 VPS 或个人正在使用的连接。

第一轮自检曾因沿用旧的 96px 断言而出现 47 passed / 1 failed，原始记录保留在 `build-results/manager-v2-initial.json`。调整断言为本轮要求的 116px 后才得到上述结果，未删除安全断言。

由于旧预览 EXE 仍由用户打开，本轮额外生成 `CMCP-UI-Preview-v2.exe`，不终止旧预览窗口或后台。其编译时的隔离模式与原预览相同，不读写真实连接配置，不启动连接脚本。普通业务 EXE 仍是 `Claude-MCP.exe`。未发布 4.0.0 Release。
