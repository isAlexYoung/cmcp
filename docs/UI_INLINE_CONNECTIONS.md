# 卡片缩放、排序与页内连接调整

本轮基线为 `c1562ff453e8ad0d5f356982816012fad2db11cb`，仅在 `codex/ui-card-dashboard` 开发。4.0.0 仍为开发版本，不创建 Release／标签，不更新旧目录或 VPS。

## 实现

- `CardList.cs` 替代 FlowLayoutPanel 管理卡片位置，列表与卡片启用双缓冲、ResizeRedraw，缩放时重新绘制背景与子控件。不会在实时缩放中播放排序过渡，避免旧边框残留。
- 排序采用 8px 启动阈值、鼠标捕获、卡片跟随、其他卡片缓动让位、松开保存、Esc／失去捕获取消。实现参考 [CC Switch useDragSort](https://github.com/farion1231/cc-switch/blob/main/src/hooks/useDragSort.ts) 的拖动阈值及 [ProviderList](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/ProviderList.tsx) 的排序过渡思路。当前项目是原生 WinForms，未引入 React、dnd-kit 或复制其业务代码。
- 添加和编辑共用 `TargetEditorPage`，均为主窗口内页面。地址和密码修改由 `manager-save.ps1` 复用既有健康检查、协议识别、旧版登录验证、原子目标写入及 DPAPI。重复地址、未知协议、运行中目标地址修改继续拒绝；添加不启用连接。验证失败留在本页；校验保存期间禁用重复提交和返回，结束后恢复。
- 单击卡片或蓝色地址仅展开／收起，不触发打开桌面。只有详情中的明确按钮或连接流程原有的网页登录步骤打开浏览器。入口未就绪的信息进入卡片，不再弹出图四的提示窗口。
- `InlineWorker.cs` 调用固定白名单脚本；连接、停止、打开使用 `-ManagerMode`，添加／编辑通过输入管道传递 JSON。密码不出现在命令参数、环境变量或进度中。进度协议有大小、队列长度和类型上限，丢弃原始 stderr 及后台消息。状态和固定提示显示在详情说明行，成功仍以后台状态确认。
- `manager-events.ps1` 替换 GUI 模式的对话框／进度显示函数。原 BAT 未传该开关，继续保留其界面和显式批量语义。GUI 不允许空目标落入批量启停，也不回退到不支持取消的旧版安装路径。
- 停止无需确认弹窗，启动初始化、等待网页登录、已连接时均可请求停止。沿用每台 target-controls 的 enabled／revision／requestTime；不杀共用 Node。取消后的旧进度被管理器丢弃；启动脚本在等待初始化锁和启动后台前复核版本，延迟启动不能覆盖新停止。
- target-controls 读取与替换共用现有账户互斥锁，避免并发停止时读取恰逢替换窗口而误判损坏。保留所有 JSON／条目校验，未知或损坏内容仍拒绝，不清空或重建配置。

## 本机证据与范围

Windows、本机固定 Node v22.23.3；无真实 VPS 请求。最终源码提交和 CI 运行应以 Git 提交、对应 Actions 和 Artifact 中的环境／build-info.json 为准，不能将基线 CI 当成本轮结果。

| 分类 | Passed | Failed | Skipped |
|---|---:|---:|---:|
| WinForms、真实隐藏进程、Shell 快捷方式、页面与重绘 | 102 | 0 | 0 |
| 新增页内保存与实际 start/stop 脚本取消专项 | 25 | 0 | 0 |
| Node 认证、共享会话、逐台取消、终端 | 30 | 0 | 0 |
| 原有 PowerShell 开关 | 20 | 0 | 0 |
| 原有编辑／删除隔离 | 19 | 0 | 0 |
| 合计 | 196 | 0 | 0 |

WinForms 新检查使用独立状态、受控脚本与真实 PowerShell 管道，验证进度落入卡片、A 取消不影响 B、取消后旧事件不能覆盖结果、添加成功返回并应用备注、多次实时尺寸切换与背景清理。并非通过预览的模拟连接计入这些检查。

PowerShell 专项使用生产保存函数、生产 start/stop/open 脚本，网络、后台启动和自启边缘替换为禁止真实副作用的测试桩。阻塞初始化自检时停止 A 可先完成；放行初始化后不得启动后台或登记自启。实际进入 waiting-login 后再次停止须正常结束，B 开关保持启用。旧版登录检查使用测试值和真实 DPAPI。原始 stdout/stderr 保存到 `build-results/inline-committable-evidence`；CI 在 `test-results/inline` 留存原始证据。

本机复核命令：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File F:\CMCP\tools\build-manager.ps1
```

```powershell
F:\CMCP\Claude-MCP.exe --self-test F:\CMCP\build-results\ui-detach-final.json
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File F:\CMCP\app\tests\manager-inline.test.ps1 -EvidenceDirectory F:\CMCP\build-results\inline-evidence
```

其余命令与固定断言见 `.github/workflows/validate.yml`。CI 保留 JSON、逐检查进度、stderr、截图和便携包；没有降低旧检查或增加等待上限。

## 失败保留与修正

- `ui-current.json` 为 51 passed / 1 failed：加入排序动画后，旧用例立即读取最终位置；保留最终位置断言，先增加“真实过渡已启动”检查，再推进动画到终点验证最终顺序。并未移除排序断言。
- `inline-attempt.json`：夹具漏带 cloud-api；`inline-second.json`：夹具放在系统 Temp 下被生产的禁止临时解压运行检查拒绝。改为项目下专用 build-results 夹具，不放宽生产检查。
- `inline-third.json`、`inline-fourth.json`：Windows PowerShell 的异步 Process 退出码句柄与重定向日志并发读取问题。夹具保留进程句柄、按共享读取模式读日志；不忽略非零退出码。
- `inline-final.json`：并发回归时，waiting-login 观察器一次将开关文件判为损坏；最终文件合法，日志保留在 `inline-final-evidence/fixture-error.log`。使用现有互斥锁保护读取与替换后重新执行专项和原开关回归，得到表内结果，未把单纯重跑当作修复。
- 上述临时夹具的首次错误记录有一条因 ErrorLog 路径未跟随隔离 StateDir 而追加到本机原错误日志。已在测试中显式隔离 ErrorLog；未删除或改写该日志，也未改动用户连接开关、密码、目标或后台。保留此失误说明。
- 历史 CI 的编辑保存重入失败及修复继续保留在 `UI_REFACTOR_4.0.md`，本轮不将历史失败抹除。

## 尚需人工确认

真实 Windows 窗口拖边缩放时的视觉效果、实际鼠标拖动手感、真实 VPS 登录／连接／取消、本机已有生产状态均未作为自动联机测试执行。自动重绘截图不等于 DWM 实际显示像素验收。关闭旧管理窗口后可打开新的 `Claude-MCP.exe` 检查；关闭管理窗口按原逻辑保留后台连接，无需停止原 MCP。

`CMCP-UI-Preview-v3.exe` 仅供安全预览：不读取真实连接数据、不联网，启停为模拟；真实页内连接进度需要使用正式开发 EXE。不发布 4.0.0 稳定版，不操作真实 VPS。

关闭进度管道后仍完成操作的生产事件发送器另有真实子进程回归；关闭管理界面不会因输出管道断开而中止连接准备。
