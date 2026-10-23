# 共享网页登录：保存密码和自动登录

开发基线：`70b631d99a449149197b617c29d0cd460d7e3513`，分支 `codex/ui-card-dashboard`。仍为 4.0.0 开发版；不创建新 Release／标签。只修改 `F:\CMCP`，不更新旧目录、真实 VPS 或现有连接。

## 行为与边界

- 添加和编辑页提供默认关闭的“记住密码并自动登录”。内部认证协议仍为 shared-browser，不增加伪装为旧版的执行路径。旧版原有登录保持兼容。
- 共享密码原样保存，不沿用旧版的去空格／字符整理。经 Windows 当前账户 DPAPI 加密存入现有私有状态目录。未勾选则不保存共享密码；取消勾选删除密文。同一目标、同一地址编辑时允许空白保留；换地址必须重新填写。卡片偏好只保存备注、图标、排序，不保存密码。
- 保存共享设置只做健康检查及只读协议识别，不提交密码、不创建远端会话，不影响已有桌面。仍需用户点击启动该台。
- 目标启动后创建原有 loopback 网关。仅在用户通过带随机入口凭据的共享网页打开页面后，才可能自动登录；后台初始化不会自行提交共享密码。
- 网关仅向根 HTML 加入同源外部辅助脚本，保持原 CSP，复用已有 nonce。脚本只寻找单个桌面解锁表单，通过原生 input 事件及原表单提交处理登录；不匹配改密表单，不覆盖用户或密码管理器已输入的值。辅助脚本最长观察 15 秒，提交后停止。
- 网页仅得到随机占位值，实际密码不进入 DOM／URL。网关在已验证 Host、Origin、入口 Cookie 的登录请求中识别占位值，通过当前账户子进程管道解密并替换请求正文。复用原登录串行队列、会话校验、Set-Cookie 与页面 sessionId 处理；浏览器和 MCP 使用同一对认证值。没有另发第二次背景登录。
- 每个网关最多解密并自动提交一次，提交前即消耗尝试资格。并发页面、刷新、错密码、网络不确定失败均不追加自动提交。已有有效共享会话优先校验并复用；临时校验失败不重新登录。手动成功登录也消耗自动资格，之后撤销或被接管不会自动抢回。
- 自动登录的错误响应不转发上游任意正文；保存失败日志不记录任意解析异常文本。解密子进程错误不向日志复制原始 stderr。停止时使用原 AbortSignal、目标版本与独立关闭流程，解密完成后的迟到结果不能提交。
- 新后台报告 autoLoginProtocol=1。GUI 启动自动目标前检查能力；旧后台不支持时明确失败，不启用所选目标，不停止其他连接。用户选择切换时机，本轮不操作现有后台。

## 修改范围

`TargetEditorPage`、`Manager/LocalState`、`Dashboard`、`InlineWorker`：开关、保存请求、非敏感状态、错误提示及原有停止边界。

`common.ps1`、`manager-targets.ps1`、`manager-save.ps1`、`get-password.ps1`：现有原子写入／DPAPI 的自动选项、同源保留与取消清除、精确目标名、无敏感错误输出。

`shared-autofill.mjs`：有界浏览器辅助脚本及 CSP 保留的 HTML 注入；`shared-session-gateway`：仅目标自身的一次自动登录与原会话共享；`managed-target`／`link-client`／`server`：按目标提供凭据、固定失败状态、取消和能力声明。共享后台、逐台开关、系统权限、沙箱与资源限制不变。

## 验证

本机 Windows，固定 Node v22.23.3；真实 Chrome 使用单独临时配置、headless 模式及 loopback CDP，未附着用户浏览器。测试服务器均为 127.0.0.1，不执行远端 Shell。

| 类别 | Passed | Failed | Skipped |
|---|---:|---:|---:|
| WinForms／真实管道／快捷方式／重绘及自动选项 | 113 | 0 | 0 |
| Node 原 30 项与自动登录新增 10 项 | 40 | 0 | 0 |
| 原 PowerShell 开关 | 20 | 0 | 0 |
| 原编辑／删除 | 19 | 0 | 0 |
| 页内操作及旧后台拒绝 | 27 | 0 | 0 |
| 自动凭据保存、清除、DPAPI 和解析失败隐私 | 18 | 0 | 0 |
| 真实浏览器自动提交、双重认证、错误和两台隔离 | 10 | 0 | 0 |
| 合计 | 247 | 0 | 0 |

本机记录：`build-results/auto-ui-verified.json`、`auto-node-verified.tap`、`auto-controls.json`、`auto-targets.json`、`auto-inline-verified.json`、`auto-save-verified.json`、`auto-browser-verified/browser.json` 和自动进入桌面截图。CI 对固定提交重跑并上传 JSON、日志、截图、环境和便携包；受测 SHA 以 Actions 的 head_sha、环境记录及包内 build-info.json 对应，不将历史 200 项结果当作本轮结果。

新增检查保留全部原回归，验证默认不开启、JSON 不含明文、原样 Unicode 密码、保存时无登录、同源留空保留、换地址拒绝复用、取消清除、密码解析失败日志不含请求正文、匿名／跨域拒绝、CSP／nonce 保留、手动成功后的会话失效不抢回、解密期间取消无迟到提交。

真实浏览器专项使用模拟受控输入的解锁表单，验证原生 setter／input 事件到标准登录响应的完整浏览器链路。生产 target factory 和共享网关用于该测试；云端 MCP 配置是成功测试桩，不执行远端命令。A 自动登录只解密 A；MCP 断线重连不再次登录；B 错密码只提交一次，刷新不重试且不影响 A；明确停止再启动 A 才允许新一轮自动登录。

命令：

```powershell
F:\CMCP\app\runtime\node.exe --test F:\CMCP\app\tests\reconnect.test.mjs F:\CMCP\app\tests\shared-session.test.mjs F:\CMCP\app\tests\terminal-link.test.mjs F:\CMCP\app\tests\target-connections.test.mjs F:\CMCP\app\tests\shared-auto.test.mjs
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File F:\CMCP\app\tests\shared-auto-save.test.ps1
```

```powershell
F:\CMCP\app\runtime\node.exe F:\CMCP\tools\test-shared-auto-browser.mjs F:\CMCP\build-results\auto-browser
```

## 失败证据与未执行

本机第一次 GUI 回归 `auto-ui-original.json` 在 74 项后失败；第二次 `auto-ui-final.json` 在 76 项后失败。测试窗口缩放后可能覆盖未移动的真实鼠标，Pump 产生新的 MouseEnter，覆盖测试先前模拟的离开。现在把模拟离开放在事件泵之后再断言空闲状态，保留原状态和按钮断言，不改产品悬停规则、不移动用户鼠标。后续 `auto-ui-final2.json` 及 `auto-ui-complete.json` 为 113/0。

未执行真实 VPS 登录、真实用户浏览器／现有会话、各部署前端精确版本与全部浏览器矩阵；不得把 loopback 成功称为 VPS 验收。实际前端须有标准桌面解锁表单；上游 CSP 或结构不适配时保留手动登录，不放宽安全策略。新登录仍可能使原先的页面下线，本功能不是复用普通域名页面的已有登录，也不新增浏览器扩展或网页端配对。

保留旧 IME、旧布局及其他项目历史失败记录，不在此功能中修改或宣称解决。
