# CMCP Ubuntu 开发版

本目录实现 [工作目标](WORK_GOALS.md) 的第一阶段与界面内更新。支持目标：Ubuntu 22.04 LTS、x86_64、GNOME、X11。已通过 Ubuntu 22.04.5 / WSL2 下的 Linux 测试、真实 GTK / WebKit 启动和更新重启检查，原生 GNOME / X11 和真实云端连接仍需验收。

## 在 Ubuntu 上构建和启动

在项目根目录执行。需要 Node 22+（与 `app/node-version.txt` 一致的运行时）以及系统 Python 3.10+：

```bash
sudo apt update
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.0 gir1.2-dbusmenu-glib-0.4 libsecret-tools gnome-keyring openssh-client xdg-utils xdotool gnome-terminal fonts-noto-cjk
npm --prefix app ci --ignore-scripts
npm --prefix macos ci --ignore-scripts
npm --prefix linux ci --ignore-scripts
node --test linux/tests/*.test.mjs
python3 -m unittest discover -s linux/tests -p 'test_*.py' -v
python3 tools/package-linux.py --output build-results/linux --release --commit "$(git rev-parse HEAD)"
sudo apt install ./build-results/linux/CMCP-*-linux-x64.deb
cmcp
```

从应用菜单也可打开 CMCP。不要用 `sudo cmcp`。源码启动时，可在根目录创建 `runtime/` 并把本机 Linux Node 可执行文件复制为 `runtime/node`，再运行 `/usr/bin/python3 linux/desktop.py`。不要复制 Windows 的 `node.exe`。

## 当前机器的 WSL 测试环境

已安装的发行版是 `Ubuntu-22.04`，开发包安装到 `/opt/cmcp`，命令入口为 `/usr/bin/cmcp`。在 Windows PowerShell 中打开窗口：

```powershell
wsl -d Ubuntu-22.04 -- cmcp
```

窗口通过 WSLg 显示，不需要安装整套 Ubuntu Desktop。测试源码与 Linux Node 分别放在 `/home/lenovo/cmcp-linux-test/src` 和 `/home/lenovo/cmcp-linux-test/node`，没有使用 Windows 的 `node.exe` 或 `node_modules`。WSL 内重复专项测试：

```bash
export PATH="$HOME/cmcp-linux-test/node/bin:$PATH"
cd "$HOME/cmcp-linux-test/src"
node --test linux/tests/*.test.mjs
python3 -m unittest discover -s linux/tests -p 'test_*.py' -v
```

安装包后的窗口检查会使用临时空白配置、自动退出，不连接真实设备：

```bash
# 仅测试所需依赖；截图额外需要 python3-gi-cairo。
sudo apt install xvfb dbus-x11
dbus-run-session -- xvfb-run -a python3 linux/tests/native_smoke.py
# 在 WSLg 中显示窗口并检查；结束后自动关闭。
python3 linux/tests/native_smoke.py
```

WSL 的密钥环可能需要首次创建 / 解锁；这与双系统 Ubuntu 的登录密钥环相互独立。真实密钥环自动测试使用独立会话和随机测试凭据，不会把 sudo 密码当作云端密码。完整检查范围和结果见 [开发记录](DEVELOPMENT_REPORT.md)。

## 密码、配置和退出

- 用户状态：`${XDG_STATE_HOME:-$HOME/.local/state}/cmcp`，可用 `CMCP_STATE_DIR` 指定私有目录；目录必须属于当前用户，不能是符号链接。
- 密码只保存到当前桌面会话的 Secret Service / 登录密钥环；配置文件只存引用。锁定或缺少密钥环时明确报错，不回退明文。不要将另一系统的配置和加密密码文件直接覆盖过来。
- 网页连接在 Claude Desktop 和 Claude Code 中注册 `linux-pc-files`。连接后若提示 MCP 配置已更新，请重启云端 Claude。用 `linux_execute` 在本机执行 Bash，文件工具只访问已配置的目录（默认是当前桌面用户的主目录）。
- Ubuntu AppIndicators 可用时，托盘菜单提供打开主界面、查看设备状态、连接、断开、重命名、切换登录方式和退出。使用「设置 → 通用 → 关闭时最小化到托盘」控制关窗行为；隐藏窗口时后台继续连接，选择「退出程序」会停止后台。托盘服务不可用时，关窗会退出。
- 系统默认浏览器的已有窗口不会被关闭；选择具体浏览器并启用关闭选项时，只结束 CMCP 独立配置目录对应的窗口。
- Snap 版 Firefox / Chromium 的独立浏览器配置放在 `$HOME/snap/<浏览器>/common/cmcp/`，避免 Snap 无法访问隐藏的 XDG 状态目录；普通 `.deb` 浏览器使用 CMCP 状态目录内的独立配置。这些浏览器登录数据随配置保留，不混用日常浏览器配置。
- 更新使用「设置 → 关于」中的检查、下载和安装按钮；详见 [更新机制](UPDATES.md)。也可手动安装新 `.deb`。应用内更新沿用已安装的系统依赖；如果托盘所需的 `gir1.2-dbusmenu-glib-0.4` 缺失，安装新版 `.deb` 会一并安装它。
- 卸载：`sudo apt remove cmcp`，保留用户设置及密钥环密码。先在 CMCP 删除设备可清理它保存的设备密码。卸载不会未经确认操作 VPS 或删除用户自定义 MCP 工具。

## Linux 本机 MCP 工具

工具组可在「设置 → 工具」中按设备启用或关闭。文件工具和截图保存路径使用本机配置的授权目录。

| 工具 | Ubuntu 行为 |
| --- | --- |
| `linux_execute`、`linux_run_program` | 用本机 Bash 或直接运行程序，支持环境变量、工作目录、超时和独立的 stdout/stderr。 |
| `linux_start_process`、`linux_list_sessions`、`linux_process_status`、`linux_process_input`、`linux_stop_process` | 后台执行 Bash 或程序，按偏移量读取输出、写入 stdin，并按会话 ID 停止进程组。原有的 `linux_list_processes` 和 `linux_process_stdin` 也可继续使用。 |
| `linux_browser_open` | 在本机默认浏览器，或已安装的 Chrome/Chromium、Edge、Firefox 中打开网页。 |
| `linux_screenshot`、`linux_desktop_action` | 在 X11 中按显示器或区域保存新 PNG，移动、点击鼠标，输入文字或快捷键。截图区域坐标相对指定显示器，鼠标坐标相对整个桌面。 |
| `linux_toolchain_info`、`linux_adb_devices`、`linux_adb` | 查找编译、构建和 Android 工具；安装 ADB 后可以枚举设备并指定序列号。 |
| `blender_*` | 使用本机 Blender 的 MCP 插件，支持查看场景、运行脚本、查询任务和读取视口截图。Blender 工具组默认关闭。 |

Linux 进程以当前桌面用户权限运行，进程控制使用 POSIX 进程组。Windows Job 的 `memory_limit_mb` 字段不在 Linux 工具接口中。截图和鼠标键盘需要 X11，键鼠工具使用 `xdotool`，新版 `.deb` 会一并装好依赖。应用内更新沿用系统已装的依赖。

## 依赖与接口依据

- [Ubuntu Secret Tool 手册](https://manpages.ubuntu.com/manpages/jammy/man1/secret-tool.1.html)：口令通过标准输入传递。
- [Ubuntu 22.04 WebKitGTK 包](https://packages.ubuntu.com/jammy/gir1.2-webkit2-4.0)。
- [WebKitGTK 脚本消息接口](https://webkitgtk.org/reference/webkit2gtk/stable/method.UserContentManager.register_script_message_handler.html)。
- [Snap 用户数据目录](https://snapcraft.io/docs/reference/administration/data-locations/)与 [home 接口限制](https://snapcraft.io/docs/reference/interfaces/home-interface/)。
- [Ubuntu xdotool 手册](https://manpages.ubuntu.com/manpages/jammy/man1/xdotool.1.html)与 [GDK 截图接口](https://docs.gtk.org/gdk3/func.pixbuf_get_from_window.html)。
