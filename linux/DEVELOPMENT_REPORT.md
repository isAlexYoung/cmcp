# Ubuntu 第一阶段开发记录

2026-11-17，分支 `codex/ubuntu-client`。目标文件先于实现创建；本记录覆盖 Linux 首版、WSL 验证和 4.23.2 Linux 发布集成。

## 实现

- Linux 独立入口和系统适配：`linux/platform.mjs`、`desktop.mjs`、`desktop.py`、`prompt.py`、`ssh-askpass.mjs`。采用 GTK3 + WebKitGTK 桌面容器，复用既有页面；GApplication 管理桌面单实例，后端另有私有锁。状态目录使用 XDG；密码通过 stdin 保存到 Secret Service，JSON 只存引用。
- 连接管理适配：`linux/manager.mjs`、`cloud-api.mjs`、`browsers.mjs`、`ssh.mjs`。复用原有传输、自动登录、恢复和停止协议；浏览器按精确 argv 配置目录及进程出生标识清理。Snap 浏览器使用其 `common` 目录保存独立配置。
- 本机工具与连接器：`linux/tools.mjs`、`dispatcher.mjs`、`connector-source.mjs`、`app/posix-connector.mjs`。复用既有 POSIX 进程与二进制引擎，使用 `linux_*` 名称。Python 连接器由现有 POSIX 模板生成，复用其传输和配置回归测试；明确本机与 VPS 均为 Linux 但不是同一台机器。
- 共享扩展边界：`app/ssh-local-tools.mjs` 识别 Linux 状态及执行器；`app/ssh-mcp.mjs` 发送 Linux 连接器；`app/mcp-tools.mjs` 支持 Linux 分组、平台过滤、密钥环引用，预留 `linux` 前缀。`app/mcp-tools-template/AGENT.md` 和 `cmcp-tool.schema.json` 同步平台定义。
- 共用管理器：`macos/manager.mjs` 新增显式 Linux 适配参数，保留 macOS 默认值；避开浏览器禁止访问的本机端口。`macos/ui/app.js` 按能力隐藏未实现的托盘、快捷方式、自动更新、原生卸载、桌面控制和 Blender，替换 Linux 界面的 Mac / Keychain 字样。没有复制整份管理器另行维护。
- 打包：`tools/package-linux.py`、`linux/package.json`、`package-lock.json`、`cmcp.desktop`。捆绑 Linux Node、固定 npm 依赖及必要源文件，输出开发 `.deb` 与 SHA256；拒绝覆盖现有包，不收集用户状态，不执行安装后提权脚本。`tools/build-macos.mjs` 补入新共用连接器模块，避免破坏 macOS 包。
- 文档和环境：`linux/WORK_GOALS.md`、`README.md`、本文件、`.gitignore`；新增 `.github/workflows/linux.yml`，提供 Ubuntu 22.04 下测试、打包、安装及真实 GTK 冒烟检查，不挂接正式发布流程。

## 验证

| 检查 | 当前结果 |
|---|---|
| `node --test linux/tests/*.test.mjs` | 12 通过、1 Linux 运行测试在 Windows 跳过 |
| Python 3.12 `unittest discover -s linux/tests -p 'test_*.py'` | 8 通过、1 POSIX 符号链接测试在 Windows 跳过 |
| 所有 macOS Node 测试 + 受影响 SSH / MCP / 市场测试 | 192 通过、10 跳过、4 失败 |
| 改动前 HEAD 的失败对照 | 相同 4 项失败，可复现，未归因于本次改动 |
| 原有发布包校验 Python 测试 | 6 通过 |
| Chrome 中的 Linux 页面 | 首页、设置、关于页通过，无 JS 页面错误，截图已检查 |
| 源码语法、diff 空白检查 | 通过 |
| Ubuntu CI | 尚未运行远端 CI；下方记录本机 WSL 的真实运行结果 |

4 个既有失败：Mac 工具目录位置、Mac 第三方工具曝光、Mac 市场安装、Mac `HOME` 状态目录。这些测试在当前 Windows 环境使用了平台默认目录或路径假设；在隔离导出的改动前 HEAD 源码中，完全相同的测试同样失败。本轮不顺带改它们来制造全绿结果。回归日志位于 `test-results/linux-regression-final.log` 和 `linux-macos-baseline.log`，该目录为本地证据，不进入分发包。

Linux 新增测试文件：`linux/tests/platform.test.mjs`、`browsers.test.mjs`、`tools.test.mjs`、`manager.test.mjs`、`test_connector.py`、`test_package.py`。`linux/tests/native_smoke.py` 在 Ubuntu 安装包后，以普通用户在 Xvfb / D-Bus 或 WSLg 中检查真实窗口。

## WSL 实测补充

用户安装 WSL 后，在本机建立独立测试环境，没有切换双系统、安装整套 GNOME Desktop 或操作 VPS。系统安装依赖使用 WSL 的 root 入口；CMCP、构建与所有测试使用普通用户 `lenovo`。用户提供的 sudo 密码没有写入源文件、包、测试数据或云端登录。

| 环境 | 实测值 |
|---|---|
| 发行版 | Ubuntu 22.04.5 LTS，x86_64，WSL2 |
| WSL / WSLg | 3.0.5.0 / 1.0.79 |
| Linux 内核 | 6.18.58.1-1-microsoft-standard-WSL2 |
| 原生窗口依赖 | GTK 3.24.33，WebKitGTK 2.50.4 |
| Node / npm | 官方 Linux x64 Node 22.23.3 / npm 10.9.9，下载 SHA256 对照仓库清单通过 |
| 源码 / 工具隔离 | `/home/lenovo/cmcp-linux-test/src` / `node`，Linux 原生依赖，不复用 Windows npm 依赖 |
| 本地开发包 | `cmcp_4.23.2~ubuntu1_amd64.deb`，安装位置 `/opt/cmcp` |

| 检查 | WSL 实测结果 |
|---|---|
| Linux Node 专项 | 13 通过、0 失败、0 跳过，包含真实命令和后台进程启动 / 停止 |
| Linux Python 连接器及打包清单 | 9 通过、0 失败、0 跳过，包含 POSIX 符号链接检查 |
| 所有 macOS Node 测试及 SSH / MCP / host / 市场回归 | 202 通过、0 失败、4 平台相关跳过；先前 Windows 上的 4 项基线失败在 Linux 下不再出现 |
| 真实 Secret Service | 独立 D-Bus、临时密钥环、随机测试口令；Unicode / 尾随换行还原、独立凭据不串用、删除及缺失查询通过 |
| 原生 `.deb` | 实际使用 `dpkg-deb` 构建，以 root 安装，普通用户启动；安装入口 `/usr/bin/cmcp` |
| GTK / WebKit | Xvfb 和 WSLg 下首页、设置、关于页通过；页面到 GTK 再返回页面的消息桥通过 |
| 退出 | 关闭窗口后后台进程退出，`manager.lock` 删除 |
| 界面截图 | 使用 WebKit 实际渲染快照检查中文、布局和 Linux 能力入口；补装 CJK 字体 |

实际 Linux 测试暴露了 `macos/tests/connector_test.py` 的临时路径层级假设：原夹具位于 `/tmp/<test>/private`，不满足连接器真实安装目录的四层父目录约定。将夹具改成 `home/.local/share/cloudpc-link/mac-pc-files`，保留生产逻辑并通过原连接器回归。安装包的推荐依赖新增 `fonts-noto-cjk`，避免精简 WSL 环境没有中文字体。

本地证据保存在 `/home/lenovo/cmcp-linux-test/evidence/`，另复制到 Windows 的 `F:\CMCP-Dev\build-results\wsl-testing\`。包含 Linux / Python / 共享回归日志、窗口检查日志、`screenshots/home.png`、`settings.png`、`about.png` 和开发 `.deb` / `.sha256`；最终安装包哈希以同目录 `.sha256` 为准。截图不会收集真实设备配置或凭据。包版本沿用开发基线，仅供本机测试，没有创建正式发布。

## 尚未验收与后续步骤

WSL 已完成 Linux 工具、真实窗口和独立密钥环测试。仍需在用户双系统的原生 GNOME / X11 上手动检查登录密钥环解锁、Snap / deb 浏览器、SSH 终端、多屏缩放，并使用真实测试设备验证连接、停止和云端调用本机工具。WSLg 不是完整 GNOME 桌面，也不能用本地自动测试证明端到端云端连接成功。

托盘、自启、X11 桌面控制与原生卸载仍为第二阶段待办。界面内更新现已实现，见下方补充与 [更新说明](UPDATES.md)。

## 界面内更新与 4.23.2 发布集成

- `linux/updates.mjs` 精确选择 Linux x64 官方稳定更新包，复用经测试的 HTTPS 下载、代理选择、进度和 SHA256 检查。Mac 默认下载行为保持兼容。
- `linux/update_runtime.py`、`launcher.py`、`apply_update.py` 提供用户目录更新、安装前完整清单校验、原子激活、PID / 启动时间校验、界面健康确认、启动失败恢复和有界清理。配置与 Secret Service 不参加替换。
- `linux/desktop.py` 的实际 WebKit 原生消息桥支持下载 / 安装；下载在工作线程进行，安装前提供确认，可取消，准备失败时旧窗口继续运行并可重新下载。
- `tools/package-linux.py` 从相同目标目录构建正式 DEB 与更新 ZIP，清单包含版本、平台、实际源提交和逐文件摘要；固定系统启动入口可选择已验证的新版用户安装。
- `release.yml` 增加 Linux 平台及 Linux CI 闸门；`prepare-release.py` 校验 Linux ZIP / DEB 和源提交。对既有 4.23.2 使用 Linux-only 追加，保留现有资产与标签，并提供独立 Linux 源码快照。

本地新增与共享回归结果：Node 218 通过 / 4 平台项跳过 / 0 失败，Python 16 通过，发布边界测试 6 通过。新增测试覆盖错误平台 / 非官方 URL、下载摘要和真实进度、损坏包不落盘、路径穿越 / 未列文件 / 符号链接、旧进程仍运行、启动失败恢复、用户配置保留。

实际 GTK 更新集成已在 WSL2 / X11 虚拟显示通过：页面消息桥发起下载，取消首次安装后窗口继续可用，再次确认安装后原窗口和后台退出，独立安装器激活新版，新 GTK 窗口成功显示首页并回报健康，启动器选中新版，设置文件保持逐字节一致，关闭后后台与锁被清理。这项检查使用本地生成的下一版本夹具和临时配置，没有访问云端或发布虚构版本；作为 Linux 发布 CI 的必过步骤。
