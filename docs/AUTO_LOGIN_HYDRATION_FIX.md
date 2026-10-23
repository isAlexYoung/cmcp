# 自动登录早于网页初始化的修正

基线 `e9280cc5371c76ca3fead1148c95c9524674260d`，分支 `codex/ui-card-dashboard`。只修改本机 CMCP，不修改 WebDesktop、真实 VPS、当前正在运行的后台或用户浏览器。

## 问题与复现

用户截图先显示 `--:--`、很长的密码圆点及无响应的显示密码按钮，随后时钟正常、输入框清空。这与服务器已返回 HTML、React 尚未初始化完成的阶段相符。初始长值与 CMCP 随机占位值一致；真实密码由网关解密替换，设计上不会送入网页输入框。截图本身不能证明密码正确或错误。

旧 helper 只等待 input.disabled 为 false，填充后若值改变就停止。旧版网页的 SSR 输入框可能已可输入，但没有 React 的受控输入处理器；填充事件被忽略，初始化又将输入框恢复为空，于是后续永远不提交。

本机通过原生产 target factory、共享网关及独立真实 Chrome 复现：先返回可编辑 SSR 输入框，一秒后绑定受控事件并重置输入。旧代码 `build-results/hydration-before-fix/browser.json`：1 passed / 1 failed；页面完全加载后仍为空，按钮禁用，A 凭据解密次数 0、登录 POST 0、状态 waiting-login。该失败发生在自动登录步骤，不是历史 CI 的浏览器启动超时。修正后同一延迟夹具 `hydration-after-fix/browser.json` 为 10/0。

## 修正

`app/shared-autofill.mjs` 等待 React 为输入框安装独立 value setter，再填入一次性占位值，并等提交按钮通过受控状态更新启用后，调用原表单提交。使用公开 DOM descriptor，不读 React 私有 fiber / props 字段。框架在提交前重置或替换输入框时，在原 15 秒上限内重新交付同一个占位值、同步受控输入；这不是 HTTP 登录重试。调用 requestSubmit 前即停止 helper，网关一次凭据尝试规则保持不变。

真实用户输入、密码管理器填入不同内容、点击表单或键盘操作时停止自动干预；超时或退出清除仍属于 helper 的占位值。没有把密码放入 DOM、URL 或启动参数，没有放宽 CSP、Cookie、Origin / Host 检查，没有重试错误密码。没有受控 setter 的不支持页面保持手动登录，不冒充自动登录成功。

## 测试改进及结果

原来的浏览器夹具先禁用输入框，再启用，漏掉了用户部署版本的可编辑 SSR 阶段。现在 A 使用真实 React 19.2.6 的服务端渲染、延迟 hydrateRoot、useState / onChange / onSubmit、useEffect 时钟和显示密码按钮；B 保留原先快速初始化的夹具，确保错误密码、刷新不重试及多台隔离继续覆盖。新增断言要求 React 初始化前输入框为空且没有占位值、实际 React 初始化完成后才登录成功。保留原来的 10 项认证、重连、停止及隔离断言。

React、ReactDOM、esbuild 的固定版本及锁文件只位于 `tests/browser-fixture`；用于回归，不修改 app/package.json / lock，不加入运行依赖或便携包。测试在本机 loopback 和独立 headless Chrome / Edge 配置运行，不附着个人浏览器，不运行远端命令。

| 当前本机类别 | Passed | Failed | Skipped |
|---|---:|---:|---:|
| WinForms / 真实隐藏 worker | 116 | 0 | 0 |
| Node 认证 / 多台 / 重连 | 40 | 0 | 0 |
| 目标开关 | 20 | 0 | 0 |
| 编辑删除 | 19 | 0 | 0 |
| 页内操作 / 取消 | 27 | 0 | 0 |
| DPAPI 密码保存 | 18 | 0 | 0 |
| 静默重启 | 15 | 0 | 0 |
| 真实 React 浏览器链路 | 12 | 0 | 0 |
| 合计 | 267 | 0 | 0 |

原始记录：build-results/hydration-ui.json、hydration-node.tap、hydration-controls.json、hydration-targets.json、hydration-inline.json、hydration-save.json、hydration-restart/restart.json、hydration-real-react/browser.json。独立 Edge 检查另记录于 hydration-real-react-edge。固定受测 SHA 由 CI head_sha、environment.json 及便携包 build-info.json 对应；历史成功及失败均不作为当前提交的新成功证据。

本机依赖安装首次使用了并不存在的 C 盘 npm 路径，报 MODULE_NOT_FOUND；改用实际 F 盘 npm 后安装成功，没有改变运行环境或全局依赖。旧 helper 的失败复现保留，不删除断言。

尚未执行用户真实 VPS 当前前端版本的人工验收。用户关闭再打开 `F:\CMCP\Claude-MCP.exe` 会按既有行为重启后台、载入修正；原共享入口会失效，需要使用新入口。不能将本机复现及 React 专项通过扩展为已经修好所有生产部署。
