using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    internal static class L {
        internal static string Language="zh-CN";
        internal static event Action Changed;
        internal static void Set(string value){Language=value=="en"?"en":"zh-CN";if(Changed!=null)Changed();}
        static readonly Dictionary<string,string> words=new Dictionary<string,string>{
            {"设置","Settings"},{"通用","General"},{"关于","About"},{"返回","Back"},{"添加云电脑","Add cloud PC"},{"编辑云电脑","Edit cloud PC"},{"保存","Save"},{"添加","Add"},{"取消","Cancel"},
            {"选择图片…","Choose image…"},{"恢复默认","Reset icon"},{"名称 / 备注","Name / note"},{"云电脑地址","Cloud PC address"},{"密码（手动共享网页登录可留空）","Password (optional for manual browser login)"},{"密码（已加密保存；同一地址留空保留）","Password saved securely; leave blank to keep it"},
            {"记住密码并自动登录（共享网页登录）","Remember password and sign in automatically"},{"勾选后，保存时不登录；启动连接后自动尝试一次。新登录可能让旧页面下线。取消勾选会删除共享模式保存的密码。","Saving does not sign in. Starting the connection allows one automatic sign-in. A new login may replace an older session. Turning this off removes the saved shared-login password."},
            {"连接状态","Connection status"},{"登录方式","Sign-in method"},{"打开云电脑","Open desktop"},{"停止连接","Disconnect"},{"查看日志","View logs"},{"成功连接","Connected"},{"未连接","Connect"},{"已连接","Connected"},{"连接中","Connecting"},{"正在停止","Stopping"},{"已停止","Stopped"},{"等待网页登录","Waiting for browser sign-in"},{"正在连接","Connecting"},{"正在配置 Claude","Setting up Claude"},{"Claude 配置待处理","Claude setup pending"},{"等待网络恢复","Waiting for network"},{"连接已被接管","Connection replaced"},{"需要更新密码","Update password"},{"登录暂时锁定","Sign-in locked"},{"访问已过期","Access expired"},{"状态已过期","Status unavailable"},{"请检查地址","Check address"},{"云端尚未配置","Cloud setup required"},{"连接异常","Connection error"},{"尚未连接","Not connected"},
            {"共享网页登录","Shared browser sign-in"},{"共享网页自动登录","Automatic browser sign-in"},{"自动识别 / 旧版","Automatic / legacy"},
            {"界面语言","Interface language"},{"简体中文","简体中文"},{"切换后立即生效，保存到当前 Windows 账户。","Changes apply immediately and are saved for this Windows account."},
            {"外观主题","Appearance"},{"浅色","Light"},{"深色","Dark"},{"跟随系统","System"},{"窗口行为","Window behavior"},{"开机自启","Start with Windows"},{"登录 Windows 后启动到系统托盘；只恢复原来已启用的连接。","Start in the system tray after Windows sign-in. Only previously enabled connections resume."},
            {"关闭窗口时","When closing the window"},{"直接退出程序","Exit application"},{"隐藏到系统托盘","Hide to system tray"},{"直接退出会断开全部云电脑；隐藏到系统托盘会保留已连接的云电脑。","Exiting disconnects all cloud PCs. Hiding to the system tray keeps connections active."},
            {"桌面快捷方式","Desktop shortcut"},{"创建快捷方式","Create shortcut"},{"为当前程序创建 CMCP 桌面快捷方式。","Create a CMCP desktop shortcut for this installation."},{"快捷方式已创建。","Desktop shortcut created."},
            {"版本","Version"},{"检查更新","Check for updates"},{"前往发布页","Open releases"},{"程序文件夹","Program folder"},{"日志文件夹","Log folder"},{"打开主界面","Open main window"},{"退出程序","Exit application"},
            {"未能确认全部连接已断开，请稍后重试退出。","Could not confirm all connections have stopped. Please try exiting again."},
            {"正在检查更新…","Checking for updates…"},{"已是最新版","You are up to date"},{"有可用更新","Update available"},{"检查失败，请重试","Could not check; try again"},{"正在下载并校验更新…","Downloading and verifying update…"},{"更新已准备，正在重新启动…","Update verified. Restarting…"},{"更新未完成，请查看本机日志。","Update did not complete. See local logs."},
            {"源码目录不会自动覆盖，请从发布页下载便携包。","Source checkouts are protected. Download a portable package from Releases."},{"请先完成或取消正在处理的卡片操作。","Finish or cancel the current card action first."},
            {"切换浅色 / 深色主题","Switch light / dark theme"},{"添加新的云电脑，不会自动连接","Add a cloud PC without starting it"},{"设置和更新入口将在后续版本开放","Settings and updates"},
            {"编辑备注、图标和云电脑地址","Edit name, icon and address"},{"复制云电脑地址","Copy cloud PC address"},{"删除这一台云电脑，其他连接保持不变","Remove this cloud PC; keep other connections"},{"展开 / 收起详情","Expand / collapse details"},{"点击卡片展开详情；拖动左侧手柄排序；Alt + ↑ / ↓ 调整顺序","Click to expand. Drag the handle or use Alt + Up / Down to reorder."},
            {"点击停止此云电脑的连接","Disconnect this cloud PC"},{"连接中；可点击停止，或展开详情打开网页登录","Connecting: click to stop, or expand to open browser sign-in"},{"点击启动这一台云电脑","Connect this cloud PC"},
            {"返回列表，不保存本次修改","Back without saving"},{"选择 PNG、JPEG 或 ICO，最多 1 MiB","Choose PNG, JPEG or ICO, up to 1 MiB"},{"移除自定义图标，使用默认图标","Reset to default icon"},{"保存这台云电脑的修改","Save this cloud PC"},
            {"请输入完整的 HTTPS 云电脑地址，不含路径或登录信息。","Enter an HTTPS root address without a path or credentials."},{"请填写自动登录密码；更换地址时需要重新填写。","Enter the automatic sign-in password. A different address requires a new password."},{"名称不能包含控制字符。","The name cannot contain control characters."},
            {"设置已保存。","Settings saved."},{"设置未能保存，请检查本机文件和注册表权限。","Could not save settings. Check local file and registry permissions."},{"操作未完成，请查看本机日志；其他连接不受影响。","Action did not complete. See local logs; other connections are unaffected."},
            {"请先停止此连接，再修改地址、密码或自动登录；备注和图标可随时修改。","Disconnect this PC before changing its address or sign-in details. The name and icon can be edited at any time."},
            {"交互预览 · 示例数据，不会连接 VPS","Interactive preview: sample data, no VPS connection"},{"本地状态暂时无法完整读取，将自动刷新","Local status is incomplete; refreshing automatically"},{"界面偏好文件无法读取，已保留原文件","Could not read interface preferences; original file preserved"},{"后台状态未更新，请检查连接","Backend status is stale; check the connection"},{"后台尚未运行 · 打开界面不会自动连接","Backend is not running"},
            {"后台已报告连接成功。可在云端 Claude 使用本机工具；新增配置后需完全退出并重新打开 Claude。","Connected. Claude on the cloud PC can use local tools. Restart Claude after adding a new configuration."},
            {"点击“打开云电脑”，在共享网页入口输入桌面密码。MCP 将共用这次登录。","Open the desktop and sign in. MCP shares that browser session."},{"此云电脑已停止。点击“启动连接”只连接这一台；其他云电脑保持原状。","This cloud PC is stopped. Starting it does not change other connections."},
            {"点击连接开始；进度会显示在此处，可随时停止。","Click Connect to begin. Progress appears here; you can stop at any time."},{"等待共享网页使用保存的密码登录；自动尝试失败后可手动输入密码。","Waiting for automatic browser sign-in. You can enter the password manually if it fails."},
            {"当前使用网页终端兼容通道。","Using the compatible browser terminal channel."},{"地址已复制（不包含登录凭据）","Address copied without credentials"},{"已打开此台云电脑。","Desktop opened."},{"此台连接已停止。","Disconnected."},
            {"返回云电脑列表","Back to cloud PCs"},
            {"删除云电脑","Remove cloud PC"},
            {"展开连接详情","Expand details"},
            {"收起连接详情","Collapse details"},
            {"切换浅色或深色","Switch light / dark theme"},
            {"保存云电脑","Save cloud PC"},
            {"是否创建桌面快捷方式？","Create a desktop shortcut?"},
            {"名称：CMCP\r\n快捷方式将打开本机连接管理界面。","Name: CMCP\r\nThe shortcut opens this connection manager."},
            {"下次不再提示","Don't ask again"},
            {"是","Yes"},
            {"否","No"},
            {"保存的密码不正确或无法读取，已停止自动尝试。请停止此连接后编辑密码，或在共享网页手动登录。","The saved password is incorrect or unreadable. Automatic attempts have stopped. Disconnect before editing the password, or sign in manually in the browser."},
            {"登录暂时锁定，已停止自动尝试。请等待云电脑解除限制后再手动登录。","Sign-in is temporarily locked. Automatic attempts have stopped. Wait for the cloud PC to unlock, then sign in manually."},
            {"访问已过期，已停止自动尝试。请先更新云电脑的访问权限或密码。","Access has expired. Automatic attempts have stopped. Update the cloud PC permissions or password."},
            {"正在通过现有流程检查云端 Claude 配置，请等待。","Checking Claude configuration on the cloud PC. Please wait."},
            {"连接已建立，但 Claude 配置尚未确认。可查看日志，后台按原规则重试。","Connected, but Claude configuration is not yet confirmed. Check the logs; the backend will retry."},
            {"后台正在等待网络或云端恢复。共享模式不会自动抢回失效的网页登录。","Waiting for the network or cloud PC to recover. Shared mode will not replace an expired browser session automatically."},
            {"其他电脑或进程已接管连接。本机会停止竞争；需要时手动启动连接。","Another computer or process replaced this connection. Start it manually when needed."},
            {"本地状态超过 30 秒未更新，暂不确认连接有效。此界面不会主动探测 VPS。","Local status has not refreshed for over 30 seconds. The manager cannot confirm the connection and will not probe the VPS."},
            {"正在取消此台连接…","Cancelling this connection…"},
            {"正在打开此台云电脑…","Opening this desktop…"},
            {"正在准备连接…","Preparing connection…"},
            {"[1/5] 正在检查运行环境...","[1/5] Checking the runtime…"},
            {"[2/5] 正在检查云电脑设置...","[2/5] Checking cloud PC settings…"},
            {"[3/5] 正在启动后台连接服务...","[3/5] Starting the connection service…"},
            {"[4/5] 正在连接云电脑...","[4/5] Connecting to the cloud PC…"},
            {"[5/5] 正在检查云电脑上的 Claude 配置...","[5/5] Checking Claude configuration…"},
            {"本机服务自检通过。","Local service self-test passed."},
            {"云电脑设置已保存。","Cloud PC settings saved."},
            {"仅启动所选云电脑；其他连接和开关保持不变。","Starting only the selected PC. Other connections are unchanged."},
            {"已连接到云电脑。","Connected to the cloud PC."},
            {"正在校验地址和登录协议…","Validating the address and sign-in protocol…"},
            {"正在保存，请等待本页校验完成。","Saving; wait for validation to finish."},
            {"该位置尚不存在。首次连接后会生成日志。","This location does not exist yet. Logs are created after the first connection."},
            {"此卡片正在处理操作，请完成后重试。","This card is busy. Try again after the operation finishes."},
            {"此卡片正在修改，请完成后重试。","This card is being edited. Try again when it finishes."},
            {"所选云电脑已不存在，请返回列表。","This cloud PC no longer exists. Return to the list."},
            {"该地址已经添加，未覆盖其他云电脑。","This address is already saved. Other cloud PCs were not changed."},
            {"剪贴板暂时不可用，请稍后重试。","The clipboard is unavailable. Try again later."},
            {"无法保存界面偏好，未更改连接信息。","Could not save interface preferences. Connection settings were not changed."},
            {"仅用于共享网页登录。密码使用当前 Windows 账户加密，不会显示原密码；旧版仍沿用原有登录方式。","For shared browser sign-in only. Passwords are encrypted for this Windows account and are never displayed. Legacy sign-in keeps its original behavior."},
            {"正在检查当前安装","Checking the current installation"},
            {"正在获取更新信息","Getting update information"},
            {"正在下载更新","Downloading update"},
            {"正在校验下载文件","Verifying the download"},
            {"正在解压更新","Extracting update"},
            {"正在校验安装包","Verifying the package"},
            {"更新未完成","Update did not complete"},
            {"正在准备更新","Preparing update"},
            {"个文件","files"},
            {"程序重启后完成更新，原安装会保留备份。","The app will restart to finish. A backup of the previous installation is retained."},
            {"请稍候；验证完成前不会替换当前安装。","Please wait. The current installation stays in place until verification succeeds."},
            {"下载连接失败，请检查网络或代理后点击更新重试。","Download failed. Check the network or proxy, then click Update to retry."},
            {"下载超时，请检查网络后点击更新重试。","The download timed out. Check the network, then click Update to retry."},
            {"无法验证下载服务器的安全连接，请检查系统时间或代理。","The download server could not be verified. Check the system clock or proxy."},
            {"当前安装文件缺失、已修改或含额外文件，请使用完整安装包。","Installation files are missing, modified, or contain extra files. Use a complete portable package."},
            {"无法写入更新目录，请检查文件夹权限和磁盘空间。","The update directory could not be written. Check permissions and available space."},
            {"没有找到有效的 Windows 更新包，请前往发布页检查。","No valid Windows update package was found. Check the release page."},
            {"下载文件校验失败，当前安装未替换，请点击更新重新下载。","Download verification failed. The installation is unchanged. Click Update to download again."},
            {"安装包内容不完整或校验失败，当前安装未替换，请重新下载。","The package is incomplete or failed verification. The installation is unchanged. Download again."},
            {"运行中的程序与安装目录不匹配，请从安装文件夹重新启动。","The running app does not match the installation. Restart it from the installation folder."},
            {"更新准备失败，当前安装未替换；可重试或在设置中打开日志文件夹。","Update preparation failed. The installation is unchanged. Retry or open the log folder in Settings."},
        };
        internal static string Text(string value){string translated;return Language=="en"&&words.TryGetValue(value,out translated)?translated:value;}
        internal static string Message(string value){
            if(Language!="en")return value;
            string result=Text(value);if(result!=value)return result;
            foreach(var pair in words.OrderByDescending(p=>p.Key.Length))if(pair.Key.Length>=6)result=result.Replace(pair.Key,pair.Value);
            if(result.Any(c=>c>=0x4e00&&c<=0x9fff))return "See the connection status and local logs for details.";
            return result;
        }
    }
    internal sealed class LocalToolTip : ToolTip {
        readonly Dictionary<Control,string> source=new Dictionary<Control,string>();
        internal LocalToolTip(){L.Changed+=RefreshLanguage;}
        public new void SetToolTip(Control control,string text){source[control]=text;base.SetToolTip(control,L.Text(text));}
        void RefreshLanguage(){foreach(var pair in source)if(!pair.Key.IsDisposed)base.SetToolTip(pair.Key,L.Text(pair.Value));}
        protected override void Dispose(bool disposing){if(disposing){L.Changed-=RefreshLanguage;source.Clear();}base.Dispose(disposing);}
    }
}
