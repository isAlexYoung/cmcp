# CC 兼容连接与恢复开发记录

日期：2026-10-28。基线 c42b7a382cb54bfd4c4eff46c8a5a1598dca6d62；开发分支 codex/cc-connection-recovery。没有发布新版，也没有替换日常使用的 EXE。

## 实现

- 识别认证后的 CC pty-v2 能力，复用 Beta 的终端传输与 Python 中继。新版 CC 不再先尝试不存在的专用 socket。WebSocket 发送匹配来源，Cookie 与页面会话一起传递。
- 兼容传输改为 8192 字节分块、最多 4 块等待确认，满足 CC 原有 16384 字节输入和 65536 字节 IPC 上限。没有提高服务器预算。
- 每秒一次随机 nonce 探针，以单调时钟判断约五秒无回复；兼容模式只认 Python 中继的应用回复，不用 WebSocket 自动 pong 或无关流量掩盖故障。重试从 1 秒增长到最多 30 秒，不承诺所有故障五秒内修复。
- Windows/macOS 显示“正在恢复”。配置与工具目录往返确认后才显示连接成功；配置失败显示单独错误并重试。首次增加或更新 Claude MCP 配置仍可能需要重启 Claude。
- 保留现有每目标/会话恢复缓存：未送达可重试；已发送但结果未知只查询。进程重启、缓存失效或会话变更后返回未知，不自动执行第二次。被接管或手动停止不继续竞争。
- CC 模式通过 wdguest 数据组共用 Claude Desktop 配置、MCP 组件和 Unix socket；只有 CC 明确声明此能力时启用。普通 Beta 保留原有同 UID/0600 路径。CC 的原有 `.gui` 总目录、浏览器 Profile 和后台凭据不开放。
- 配置仍用原来的合并、备份、原子写入和回滚流程，保留既有设置及其他 MCP。CC 共享写入限定两处数据子树，检查身份、属组、目录和链接，通过目录描述符创建/替换 0660 文件；不执行 root 或 sudo。

## 本地结果

以下均为 Windows 本地，不是 Debian/VPS 验收。

| 检查 | 实际结果 |
| --- | --- |
| node --test：reconnect、terminal-link、request-recovery、connection-health、shared-session、target-connections、macos manager | 54 PASS，退出 0 |
| Python test_cc_shared.py | 6 PASS、1 SKIP，退出 0；双平台配置保留、共享写入/目录身份模型、拒绝外部路径/链接/错误身份、应用探针 |
| Python test_request_recovery.py | 14 PASS、2 SKIP，退出 0 |
| macos connector_test.py | 6 PASS、1 SKIP，退出 0 |
| Windows Manager 编译及 --self-test | 244 PASS、0 FAIL，退出 0 |
| CC 仓库 tests/cmcp_compat_checks.mjs | 3 PASS，真实网关与客户端使用本机 HTTP/WebSocket；Linux 身份、PTY、认证后台和 systemd 显式建模 |
| 修改的 JS/Python 语法与 Git 差异检查 | PASS；原有 macOS Python CRLF 按既有格式保留，差异检查使用 cr-at-eol |

首次 Manager 测试把 EXE 放到没有 app/common.ps1 的临时目录，最后一项跨 PowerShell 顺序检查出现 FormatException（241 条已通过）；补全测试夹具中的 common.ps1 和 target-controls.ps1 后重新编译，244 条全部通过，未修改顺序分配代码。早期共享会话测试曾发现 onConnected 状态契约不兼容，已修复并包含在最终 54 条通过结果中。

## 未验收与边界

真实 Debian wdterm/wdgui 权限、Unix socket、systemd bind mount、真实 PTY、Claude Desktop 启动/重新加载 MCP、macOS 原生 App、实际公网抖动与服务器重启均 NOT RUN。Windows POSIX 模型不能证明这些成功。没有访问任何 VPS、没有运行 Actions/QEMU/完整 CI。

CC worker 和 GUI unit 有系统层变化；既有 VPS 必须先做管理员审核的系统层维护与旧 Claude 配置迁移。没有提供静默移动旧 Profile、清除状态或跨版本接管入口。旧 1.4.0/Beta/tag/Public 版本目录不变。用户此前已有的 .gitignore 修改保留，未纳入本次开发。
