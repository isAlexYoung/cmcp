# Chrome 直连云桌面

## 行为

支持新协议的 WebDesktop：CMCP 的本机入口只办理一次性票据，随后浏览器直接打开原 HTTPS 域名。HTML、静态资源、API、文件下载和 GUI WebSocket 不再由 CMCP 转发。默认浏览器管理自己的网络、代理和缓存；CMCP 继续管理本机 MCP 工具通道。

直连页面的缓存遵循浏览器设置，退出 CMCP 不会清除 Chrome 自身缓存；CMCP 不清理个人浏览器配置或其他网站数据。原兼容转发方式的 CMCP 内存缓存仍在退出时清空。

- 开启自动登录：只在用户点击打开时读取已保存密码，通过 HTTPS 提交一次；密码不会出现在网址、网页脚本、入口文件或日志中。
- 关闭自动登录：在原域名页面输入密码，登录成功后工具通道取得独立凭据。
- 保存密码错误：仅提交一次错误密码，转为网页手动登录，不循环尝试。
- 重开已登录桌面：重新签发一次性票据，复用原桌面会话，不重复接管。
- 短暂断网：工具沿用原恢复逻辑；尚未完成的准备请求保留同一请求标识，重试不会重复创建桌面会话。
- 被其他登录接管后不在后台重新输密码；只有用户再次点击打开才允许主动登录。
- 旧 WebDesktop 无此协议时，继续使用原共享会话转发方式；云端故障不会被当作旧版本而静默降级。

## 接口

`GET /api/auth/cmcp` 返回 `{protocol:"cmcp-direct",version:1}`。

`POST /api/auth/cmcp` 的 `prepare/claim/poll/stop` 操作使用独立随机控制秘密与一次性票据。服务端只保存秘密摘要，票据有效期五分钟。票据通过 `#cmcp=<id>.<secret>` 传入，页面立即清除地址中的片段。

Windows 的 `browser-entries.json` 格式、原启动入口路径及 macOS 打开操作保持兼容；其中仍只有本机启动入口，不保存远程登录票据或用户密码。

工具凭据为 `wd_cmcp`，与浏览器的 `wd_session` 分开，不能当作桌面 Cookie 使用。服务端仅允许认证检查、访客信息、连接组件文件和访客终端所需接口，不能用它打开 GUI、下载接口、密码设置或管理员后台。访客执行器原有文件权限和隔离继续生效。

## 验证与使用条件

- CMCP Node 回归包含九个直连用例，共 91 项。
- WebDesktop 认证用例九项：自动/手动、并发消费与重放、原会话恢复、事务失败、到期/撤销、输入/来源、匿名容量边界。
- 真正的 Chrome + React StrictMode 浏览器联调覆盖自动登录、手动登录、错密码转手动、直接输入网址；验证接口与首帧走远程地址、MCP 工具往返、刷新和重开保留会话。
- Mac 后端回归在 Windows 可执行的部分通过；Mac 原生 GUI 需要发布构建环境验证。

CMCP 4.7.0 配合 WebDesktop 1.9.0 启用新模式，旧 WebDesktop 保持兼容。发布包不自动替换本机正在使用的安装。浏览器联调使用真实业务认证代码和事务适配器，GUI/工具载荷为测试替身，未据此声称真实 PostgreSQL、多进程竞争或 Linux VPS 已完成验收。

复现浏览器联调（WebDesktop 仓库，已安装开发依赖及 Chrome）：

```powershell
node tests/cmcp_direct_browser_test.mjs F:\CMCP-Dev
```

本机结果：`F:\des12\.test-results\cmcp-direct\browser-result.json`。
