using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("CMCP")]
[assembly: System.Reflection.AssemblyProduct("CMCP")]
[assembly: System.Reflection.AssemblyVersion("4.19.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("4.19.1.0")]

namespace CMCP {
    internal sealed class Target {
        public string Name, Url, Mode, State, Detail;
        public bool AutoLogin, HasSavedPassword;
        public bool? DesktopClient, CliClient;
    }
    internal sealed class Snapshot {
        public bool Running, Stopped, ReadError, Stale;
        public List<Target> Targets = new List<Target>();
    }
    internal static class LocalState {
        internal static string Text(object value) { return value as string ?? ""; }
        internal static object Get(IDictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) ? v : null; }
        internal static IDictionary<string, object> Obj(object value) { return value as IDictionary<string, object>; }
        internal static object Read(string file) {
            if (!File.Exists(file)) return null;
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                if (stream.Length > 4 * 1024 * 1024) throw new InvalidDataException("Local state too large");
                using (var reader = new StreamReader(stream, Encoding.UTF8, true)) {
                    var serializer = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024, RecursionLimit = 32 };
                    return serializer.DeserializeObject(reader.ReadToEnd());
                }
            }
        }
        internal static bool? ClientFlag(IDictionary<string, object> entry, string key) { object value; var clients = Obj(Get(entry, "clients")); return clients != null && clients.TryGetValue(key, out value) && value is bool ? (bool?)(bool)value : null; }
        internal static string ClientState(string state, bool running) {
            switch (state) {
                case "connected": case "configuring": case "config-error": return running ? "已连接" : "未运行";
                case "recovering": case "unstable": case "connecting": case "offline": case "waiting-login": return running ? "正在重连" : "未运行";
                default: return "已断开";
            }
        }
        internal static string Caption(string state) {
            switch (state) {
                case "connected": return "已连接";
                case "waiting-login": return "等待网页登录";
                case "connecting": return "正在连接";
                case "configuring": return "正在配置 Claude";
                case "config-error": return "Claude 配置待处理";
                case "unstable": return "正在恢复";
                case "recovering": return "正在恢复";
                case "offline": return "等待网络恢复";
                case "replaced": return "连接已被接管";
                case "password": return "需要更新密码";
                case "locked": return "登录暂时锁定";
                case "expired": return "访问已过期";
                case "stopped": return "已停止";
                case "stale": return "状态已过期";
                case "url": return "请检查地址";
                case "notset": return "云端尚未配置";
                case "error": return "连接异常";
                default: return "尚未连接";
            }
        }
        internal static string Detail(string state) {
            switch (state) {
                case "connected": return "后台已报告连接成功。可在云端 Claude 使用本机工具；新增配置后需完全退出并重新打开 Claude。";
                case "waiting-login": return "点击“打开云电脑”，在网页桌面入口输入桌面密码。MCP 将共用这次登录。";
                case "password": return "保存的密码不正确或无法读取，已停止自动尝试。请停止此连接后编辑密码，或在网页桌面手动登录。";
                case "locked": return "登录暂时锁定，已停止自动尝试。请等待云电脑解除限制后再手动登录。";
                case "expired": return "访问已过期，已停止自动尝试。请先更新云电脑的访问权限或密码。";
                case "configuring": return "正在通过现有流程检查云端 Claude 配置，请等待。";
                case "config-error": return "连接已建立，但 Claude 配置尚未确认。可查看日志，后台按原规则重试。";
                case "offline": return "后台正在等待网络或云端恢复。共享模式不会自动抢回失效的网页登录。";
                case "unstable": return "连接短暂波动，正在继续探测；已保留登录和工具配置，恢复后继续使用。";
                case "recovering": return "连接暂时中断，正在自动重连并重新确认工具链路；未确认结果的操作不会自动重发。";
                case "replaced": return "其他电脑或进程已接管连接。本机会停止竞争；需要时手动启动连接。";
                case "stale": return "本地状态超过 30 秒未更新，暂不确认连接有效。此界面不会主动探测 VPS。";
                case "stopped": return "此设备已停止。点击“启动连接”只连接这一台；其他设备保持原状。";
                default: return "点击连接开始；进度会显示在此处，可随时停止。";
            }
        }
        internal const string SelfHostedReady="自行安装的 CloudCLI：网页可以打开；本机工具经此设备的 SSH 后台通道连接。",SelfHostedDown="自行安装的 CloudCLI 暂时无法访问，正在重试。";
        internal static string PreparationDetail(string state, string message) {
            if(state=="error"&&new[]{"SSH 认证失败，请检查密码或密钥。","SSH 主机指纹校验失败，请核对服务器指纹。","无法启动 SSH 客户端，请检查系统的 OpenSSH 安装。"}.Contains(message))return message;
            if(state=="offline"&&message=="CloudCLI 尚未提供 CMCP 登录接口，请升级 VPS 上的 WebDesktop。")return message;
            // A self-hosted CloudCLI (app/managed-target.mjs): fixed texts only.
            if(state=="connected"&&message==SelfHostedReady||state=="offline"&&message==SelfHostedDown)return message;
            if (state != "connecting" && state != "recovering") return null;
            // Only fixed local stage text is displayed, never arbitrary backend
            // errors, URLs, paths, cookies or credential-bearing values.
            const string pattern = @"^(正在检查云端连接能力|正在准备连接组件目录（[1-3]/3）|正在检查云端连接组件|正在校验云端连接组件|正在更新云端连接组件|连接组件已就绪，正在建立 MCP 通道)(，正在重试当前步骤（[2-4]/4）|，正在核对上次写入结果|，连接暂时中断，[1-9][0-9]{0,4} 秒后继续)?$";
            return message != null && message.Length < 160 && System.Text.RegularExpressions.Regex.IsMatch(message,pattern) ? message : null;
        }
        internal static string WorkerDetail(Target target, string message, bool busyConnect) {
            bool waiting=busyConnect&&message.StartsWith("[4/5]")&&
                (new[]{"waiting-login","offline","configuring","recovering","unstable"}.Contains(target.State)||PreparationDetail(target.State,target.Detail)!=null);
            return waiting ? Caption(target.State)+" · "+target.Detail : message;
        }
        internal static Snapshot Load(string directory) {
            var result = new Snapshot();
            result.Stopped = File.Exists(Path.Combine(directory, "stopped.flag"));
            object targets = null; IDictionary<string, object> status = null;
            var controls = new Dictionary<string, IDictionary<string, object>>(StringComparer.Ordinal);
            bool controlled = File.Exists(Path.Combine(directory, "target-controls.json"));
            if (controlled) {
                try {
                    var data = Obj(Read(Path.Combine(directory, "target-controls.json")));
                    var entries = Get(data, "targets") as object[];
                    if (Convert.ToString(Get(data, "schema")) != "1" || entries == null || entries.Length > 400) throw new InvalidDataException();
                    foreach (var item in entries) {
                        var entry = Obj(item); string name = Text(Get(entry, "name"));
                        if (name.Length == 0 || name.Length > 512 || !(Get(entry, "enabled") is bool) || Text(Get(entry, "revision")).Length == 0 || controls.ContainsKey(name)) throw new InvalidDataException();
                        controls.Add(name, entry);
                    }
                } catch { result.ReadError = true; controls.Clear(); }
            }
            try { targets = Read(Path.Combine(directory, "cloudpc-targets.json")); } catch { result.ReadError = true; }
            try { status = Obj(Read(Path.Combine(directory, "link-status.json"))); } catch { result.ReadError = true; }
            int pid;
            if (!result.Stopped && status != null && Int32.TryParse(Convert.ToString(Get(status, "pid")), out pid)) {
                try {
                    using (var process = Process.GetProcessById(pid)) {
                        result.Running = !process.HasExited && String.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase);
                    }
                } catch { }
            }
            DateTimeOffset at;
            result.Stale = result.Running && (!DateTimeOffset.TryParse(Text(Get(status, "at")), out at) || Math.Abs((DateTimeOffset.UtcNow - at).TotalSeconds) > 30);
            var states = Obj(Get(status, "targets"));
            var list = targets as object[];
            if (list == null && Obj(targets) != null) list = new object[] { targets };
            var all=(list??new object[0]).ToList();var cloud=CloudCliStore.Load(directory);if(cloud.ReadError)result.ReadError=true;
            foreach(var login in cloud.logins)all.Add(new Dictionary<string,object>{{"name",login.ConnectionName},{"url",login.url},{"password",login.secret},{"authMode","cloudcli"},{"autoLogin",login.autoLogin}});
            foreach(var l in SshStore.Load(directory).logins)foreach(var app in new[]{"web","cloudcli"})if(app=="web"?l.webTunnel:l.cloudcliTunnel)all.Add(new Dictionary<string,object>{{"name","tunnel:"+app+":"+l.name},{"url","http://127.0.0.1:"+(app=="web"?l.webPort:l.cloudcliPort)},{"password",app=="web"?l.webSecret:l.cloudcliSecret},{"authMode",app=="web"?"shared-browser":"cloudcli"},{"autoLogin",app=="web"?l.webAutoLogin:l.cloudcliAutoLogin}});
            foreach (var item in all.Take(400)) {
                var d = Obj(item); if (d == null) continue;
                string name = Text(Get(d, "name")), url = Text(Get(d, "url")); Uri parsed;
                if (name.Length < 1 || name.Length > 512 || !Uri.TryCreate(url, UriKind.Absolute, out parsed) || (parsed.Scheme != "https" && !(name.StartsWith("tunnel:",StringComparison.Ordinal)&&parsed.Scheme=="http"&&parsed.Host=="127.0.0.1")) || !String.IsNullOrEmpty(parsed.UserInfo) || parsed.AbsolutePath != "/" || parsed.Query.Length != 0 || parsed.Fragment.Length != 0) { result.ReadError = true; continue; }
                var entry = Obj(Get(states, name));
                string state = !result.Running ? "stopped" : result.Stale ? "stale" : Text(Get(entry, "state"));
                IDictionary<string, object> control;
                if (controlled) {
                    bool enabled = controls.TryGetValue(name, out control) && Object.Equals(Get(control, "enabled"), true);
                    if (!enabled) state = "stopped";
                    else if (result.Running && !result.Stale && Text(Get(control, "revision")) != Text(Get(entry, "revision"))) state = "connecting";
                }
                string message = Text(Get(entry, "message"));
                bool auto=(Text(Get(d,"authMode"))=="shared-browser"||Text(Get(d,"authMode"))=="cloudcli")&&Object.Equals(Get(d,"autoLogin"),true);
                result.Targets.Add(new Target { Name = name, Url = parsed.GetLeftPart(UriPartial.Authority), AutoLogin=auto,HasSavedPassword=Text(Get(d,"password")).Length>0,DesktopClient=ClientFlag(entry,"desktop"),CliClient=ClientFlag(entry,"cli"),Mode = Text(Get(d, "authMode")) == "shared-browser" ? (auto?"网页桌面自动登录":"网页桌面登录") : "自动识别 / 旧版", State = state,
                    Detail = PreparationDetail(state,message) ?? ((auto&&state=="waiting-login"?"等待网页桌面使用保存的密码登录；自动尝试失败后可手动输入密码。":Detail(state)) + (state == "connected" && message.Contains("兼容") ? "\r\n当前使用网页终端兼容通道。" : "")) });
            }
            foreach(var t in result.Targets.Where(t=>t.Name.StartsWith("cloudcli:",StringComparison.Ordinal)))t.Mode="CloudCLI 登录";
            return result;
        }
    }
    internal static class Actions {
        internal static string Quote(string value) { return "'" + value.Replace("'", "''") + "'"; }
        internal static string Script(string action) {
            switch (action) {
                case "connect": return "start.ps1";
                case "add": case "edit": return "add-cloudpc.ps1";
                case "remove": return "remove-cloudpc.ps1";
                case "stop": return "stop.ps1";
                case "open": return "manager-open.ps1";
                case "uninstall": return "uninstall.ps1";
                default: throw new ArgumentException("Unknown action");
            }
        }
        internal static string Command(string kit, string action, string name, string initialUrl = "",long requestTime=0) {
            string command = "& " + Quote(Path.Combine(kit, Script(action)));
            if (action != "add" && action != "uninstall") {
                if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("Select a cloud computer first");
                command += " -TargetName " + Quote(name);
                if (action == "connect" || action == "stop") command += " -RequestTime " + requestTime.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            if (action == "edit" && initialUrl.Length > 0) command += " -InitialUrl " + Quote(initialUrl);
            // Without this, -EncodedCommand turns any exit code above 1 into 1.
            if (action == "uninstall") command += "; exit $LASTEXITCODE";
            return command;
        }
        internal static Process Start(string kit, string action, string name, string initialUrl = "",string stateDirectory=null) {
            string script = Path.Combine(kit, Script(action));
            if (!File.Exists(script)) throw new FileNotFoundException("缺少文件，请完整解压便携包。", script);
            if(action!="add"&&action!="uninstall"&&String.IsNullOrWhiteSpace(name))throw new ArgumentException("Select a cloud computer first");
            long order=action=="connect"||action=="stop"?ControlRequestOrder.Next(stateDirectory??PortableState.DirectoryPath):0;
            var command = Command(kit, action, name, initialUrl,order);
            string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            return Process.Start(new ProcessStartInfo(ps, "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = kit, WindowStyle = ProcessWindowStyle.Hidden
            });
        }
    }
    internal static class Program {
        internal static string ExecutablePath {get{string canonical=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"CMCP.exe");return File.Exists(canonical)?canonical:Application.ExecutablePath;}}
        [STAThread] static int Main(string[] args) {
#if !CMCP_PREVIEW
            string askpass=Environment.GetEnvironmentVariable(SshAskpass.Variable);
            if(!String.IsNullOrEmpty(askpass)&&args.Length<=1)return SshAskpass.Run(askpass,args.Length==1?args[0]:"");
#endif
            Motion.Suppressed=args.Length>0&&args[0]!="--startup"&&args[0]!="--updated"&&args[0]!="--demo";
            if(args.Length==2&&(args[0]=="--self-test"||args[0]=="--test-tooltips"))Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            if(args.Length==2&&args[0]=="--self-test")AppDomain.CurrentDomain.UnhandledException+=delegate(object sender,UnhandledExceptionEventArgs e){try{File.WriteAllText(args[1]+".unhandled.txt",Convert.ToString(e.ExceptionObject),Encoding.UTF8);}catch{}};
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
#if CMCP_PREVIEW
            // A separately compiled preview never reads personal connection
            // state, prompts for a shortcut or starts the bridge, even renamed.
            if (args.Length == 0) { Application.Run(new Manager(true)); return 0; }
            return 64;
#else
            if(args.Length==2&&args[0]=="--test-tooltips")return ToolTipTests.Run(Path.GetFullPath(args[1]));
            if (args.Length == 2 && args[0] == "--self-test") return SelfTest(args[1]);
            if(args.Length==3&&args[0]=="--preview-tray"){TrayTests.Capture(args[1],args[2]=="dark");return 0;}
            if (args.Length == 1 && args[0] == "--demo") { Application.Run(new Manager(true)); return 0; }
            if (args.Length >= 2 && args[0] == "--preview") {
                using (var form = new Manager(true)) {
                    if(args.Length > 2) form.ClientSize=new Size(Int32.Parse(args[2]),args.Length>3?Int32.Parse(args[3]):720);
                    form.Show();Application.DoEvents();if(args.Length>4)form.SetTheme(args[4]=="dark");
                    var first=form.Cards.Values.First();
                    string page=args.Length>5?args[5]:"expanded";
                    if(page=="editor")form.OpenEditor(first.Target.Name);
                    else if(page=="add")form.OpenAdd();
                    else if(page=="settings"||page=="settings-en"||page=="about"){if(page=="settings-en"){var options=form.Options.Copy();options.language="en";form.ChangeSettings(options);}form.OpenSettings();if(page=="about")form.Settings.ShowAbout();}
                    else if(page=="editor-web"||page=="editor-ssh"||page=="editor-key"||page=="add-ssh"){if(page=="add-ssh")form.OpenAdd();else form.OpenEditor("preview-b");if(page=="editor-web")form.Editor.ShowWeb();else form.Editor.ShowSsh();if(page=="editor-key"){form.Editor.MethodField.Choose("key");form.Editor.KeyInput.Box.Text=@"C:\Users\me\.ssh\id_ed25519";}}
                    else if(page=="card-ssh"||page=="card-ssh-expanded"){var ssh=form.Cards["preview-b"];form.SwitchLogin(ssh);foreach(var card in form.Cards.Values)card.ClearPointer();ssh.TestHover(true);if(page=="card-ssh-expanded")ssh.SetExpanded(true,false);}
                    else if(page=="dropdown"){form.OpenSettings();var field=form.Settings.Viewport.Controls[0].Controls.OfType<DropdownField>().First();field.TestClick();Application.DoEvents();using(var menu=new Bitmap(field.Menu.Width,field.Menu.Height)){field.Menu.DrawToBitmap(menu,new Rectangle(Point.Empty,menu.Size));menu.Save(Path.GetFullPath(args[1])+".menu.png",System.Drawing.Imaging.ImageFormat.Png);}field.Menu.Close();}
                    else if(page=="connect"||page=="connect-chosen"||page=="connect-menu"){
                        if(page!="connect"){var options=form.Options.Copy();options.browser=Browsers.Detect().Select(b=>b.Id).FirstOrDefault()??"";options.closeWeb=options.closeTerminal=true;form.ChangeSettings(options);}
                        form.OpenSettings();form.Settings.ShowConnect();Application.DoEvents();
                        if(page=="connect-menu"){var field=form.Settings.Viewport.Controls[0].Controls.OfType<DropdownField>().First();field.TestClick();Application.DoEvents();using(var menu=new Bitmap(field.Menu.Width,field.Menu.Height)){field.Menu.DrawToBitmap(menu,new Rectangle(Point.Empty,menu.Size));menu.Save(Path.GetFullPath(args[1])+".menu.png",System.Drawing.Imaging.ImageFormat.Png);}field.Menu.Close();}
                    }
                    else if(page=="update-available"){form.OpenSettings();form.Settings.ShowAbout();form.SimulateUpdate("9.9.9");}
                    else if(page=="main-update"){form.SimulateUpdate("9.9.9");foreach(var card in form.Cards.Values)card.ClearPointer();}
                    else if(page.StartsWith("update")){var update=new UpdateProgress{Stage=page=="update-failed"?"failed":"download",Code="network",Received=14680064,Total=41037076};if(page=="update-expanded")first.SetExpanded(true,false);form.SetUpdateProgress(update);if(page=="update-about"){form.OpenSettings();form.Settings.ShowAbout();form.Settings.SetUpdateProgress(update);}}
                    else if(page=="progress"){first.BusyConnect=true;first.Target.State="waiting-login";first.Target.Detail="[4/5] 等待网页登录 · 请在打开的云电脑网页中输入密码，可随时停止。";first.RefreshTarget(first.Target);first.SetExpanded(true,false);first.TestHover(true);}
                    else {first.SetExpanded(page=="expanded",false);foreach(var card in form.Cards.Values)card.ClearPointer();if(page!="idle")first.TestHover(true);}
                    Application.DoEvents();
                    using(var bmp=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(bmp,new Rectangle(Point.Empty,bmp.Size));bmp.Save(Path.GetFullPath(args[1]),System.Drawing.Imaging.ImageFormat.Png);}
                }
                return 0;
            }
            if (args.Length == 2 && args[0] == "--preview-shortcut") {
                using (var form = new ShortcutPrompt()) { form.Show(); Application.DoEvents(); using (var bmp = new Bitmap(form.Width,form.Height)) { form.DrawToBitmap(bmp,new Rectangle(Point.Empty,bmp.Size)); bmp.Save(Path.GetFullPath(args[1]),System.Drawing.Imaging.ImageFormat.Png); } }
                return 0;
            }
            if(args.Length==1&&args[0]=="--exit")return ManagerSignal.ExitRunning();
            if(args.Length==3&&args[0]=="--apply-installer-choices"&&(args[1]=="on"||args[1]=="off")&&(args[2]=="zh-CN"||args[2]=="en"))return InstallerChoices.Apply(PortableState.DirectoryPath,ExecutablePath,args[1]=="on",args[2]);
            bool startup=args.Length==1&&args[0]=="--startup";
            bool updated=args.Length==2&&args[0]=="--updated";
            Guid transactionId;if(updated&&!Guid.TryParseExact(args[1],"N",out transactionId))return 64;
            if (args.Length != 0&&!startup&&!updated) return 64;
            Environment.CurrentDirectory=AppDomain.CurrentDomain.BaseDirectory;
            if(startup&&!AppSettings.Load(PortableState.PreferencesPath).autoStart)return 0;
            bool created;
            using (var mutex = new Mutex(true, "Local\\ClaudeMcpManager-" + PortableState.InstanceKey, out created)) {
                if (!created) {if(!startup)ManagerSignal.Restore();return 0;}
                ThreadPool.QueueUserWorkItem(delegate{ShellIconRefresh.RefreshOnce(ExecutablePath,PortableState.PreferencesPath,null,Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory));});
                try {
                    using(var form=new Manager(false)){
                        form.Shown+=delegate{
                            if(startup)form.BeginInvoke(new Action(form.HideToTray));
                            form.InitializeBackend(()=>BackendRestart.Run(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"app"),forceRestart:updated),healthy=>{
                                if(updated)UpdateController.Acknowledge(args[1],healthy);
                                if(healthy&&!startup&&!updated&&form.Visible)ShortcutPrompt.AskBeforeManager();
                            });
                        };
                        Application.Run(form);
                    }return 0;
                }
                catch { MessageBox.Show("界面无法打开，请确认便携包完整。原有 BAT 入口仍可使用。", "CMCP", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
                finally { mutex.ReleaseMutex(); }
            }
#endif
        }
        static int SelfTest(string output) {
            var checks = new List<string>(); string temp = Path.Combine(Path.GetTempPath(), "claude-mcp-manager-test-" + Guid.NewGuid().ToString("N"));
            try {
                Directory.CreateDirectory(temp);
                DashboardTests.Trace=message=>File.AppendAllText(output+".progress.txt",DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine,Encoding.UTF8);
                Action<bool, string> check = (ok, name) => {
                    if (!ok) throw new Exception(name);
                    checks.Add(name);
                    File.AppendAllText(output+".progress.txt",DateTime.UtcNow.ToString("o")+" "+checks.Count+" "+name+Environment.NewLine,Encoding.UTF8);
                };
                check(LocalState.Load(temp).Targets.Count == 0, "empty state does not create configuration");
                ShortcutTests.Run(temp,check);
                string file = Path.Combine(temp, "cloudpc-targets.json");
                File.WriteAllText(file, "[{\"name\":\"demo\",\"url\":\"https://desktop.example.com\",\"password\":\"DO-NOT-DISPLAY\",\"authMode\":\"shared-browser\"}]", Encoding.UTF8);
                var s = LocalState.Load(temp); check(s.Targets.Count == 1 && s.Targets[0].State == "stopped", "saved target without backend is stopped");
                check(!s.Targets[0].Detail.Contains("DO-NOT-DISPLAY"), "password is not part of view model");
                check(LocalState.PreparationDetail("connecting","正在检查云端连接组件") == "正在检查云端连接组件", "connection preparation stage is visible");
                check(LocalState.PreparationDetail("recovering","正在校验云端连接组件，正在重试当前步骤（2/4）") != null, "current preparation retry is visible");
                check(LocalState.PreparationDetail("recovering","正在检查云端连接组件 cookie=DO-NOT-DISPLAY") == null, "arbitrary status text cannot expose credentials");
                check(LocalState.PreparationDetail("stopped","正在检查云端连接组件") == null, "stopped connections do not display stale preparation stages");
                check(LocalState.WorkerDetail(new Target{State="connecting",Detail="正在校验云端连接组件"},"[4/5] 正在连接云电脑...",true).Contains("正在校验云端连接组件"), "pending start worker preserves the precise backend preparation stage");
                File.WriteAllText(Path.Combine(temp, "link-status.json"), "{\"pid\":2147483647,\"targets\":{\"demo\":{\"state\":\"connected\"}}}");
                check(LocalState.Load(temp).Targets[0].State == "stopped", "dead PID never reports connected");
                File.WriteAllText(file, "[{\"name\":\"bad\",\"url\":\"https://user:secret@example.com\"}]"); check(LocalState.Load(temp).Targets.Count == 0, "credential-bearing URL is rejected");
                File.WriteAllText(file, "{"); check(LocalState.Load(temp).ReadError, "partial JSON is safe and retriable");
                check(Actions.Quote("a'b") == "'a''b'", "PowerShell arguments escape apostrophes");
                check(Actions.Command("C:\\kit's folder", "open", "x'; exit; '").Contains("-TargetName 'x''; exit; '''"), "target cannot inject PowerShell");
                foreach (string action in new string[] { "connect", "stop" }) {
                    check(Actions.Command("C:\\kit", action, "selected-A").Contains("-TargetName 'selected-A' -RequestTime "), action + " always passes selected target and request ordering");
                    bool empty = false; try { Actions.Command("C:\\kit", action, ""); } catch (ArgumentException) { empty = true; }
                    check(empty, action + " with no selection cannot stop every cloud PC");
                }
                bool rejected = false; try { Actions.Script("arbitrary-command"); } catch (ArgumentException) { rejected = true; } check(rejected, "actions are a fixed allowlist");
                check(LocalState.ClientState("connected", true) == "已连接" && LocalState.ClientState("connected", false) == "未运行" && LocalState.ClientState("recovering", true) == "正在重连" && LocalState.ClientState("stopped", true) == "已断开", "each Claude client reports connected, reconnecting, disconnected or not running");
                string clientsState = Path.Combine(temp, "clients-state"); Directory.CreateDirectory(clientsState);
                File.WriteAllText(Path.Combine(clientsState, "cloudpc-targets.json"), "[{\"name\":\"A\",\"url\":\"https://a.example.com/\"},{\"name\":\"B\",\"url\":\"https://b.example.com/\"}]");
                File.WriteAllText(Path.Combine(clientsState, "link-status.json"), "{\"pid\":0,\"targets\":{\"A\":{\"state\":\"connected\",\"clients\":{\"desktop\":true,\"cli\":false}},\"B\":{\"state\":\"connected\"}}}");
                var loaded = LocalState.Load(clientsState).Targets; check(loaded[0].DesktopClient == true && loaded[0].CliClient == false && loaded[1].DesktopClient == null && loaded[1].CliClient == null, "client state is read when reported and stays unknown otherwise");
                check(Actions.Command("C:\\kit", "uninstall", "") == "& 'C:\\kit\\uninstall.ps1'; exit $LASTEXITCODE", "uninstall runs its fixed script without a selected target and keeps its exit code");
                string setupKey=@"Software\CMCP-SelfTest-"+Guid.NewGuid().ToString("N"),setupRoot=Path.Combine(temp,"installed"),setupState=Path.Combine(setupRoot,"user"),setupExe=Path.Combine(setupRoot,"CMCP.exe"),removal=Path.Combine(temp,"unins000.exe");
                Directory.CreateDirectory(setupRoot);File.WriteAllText(setupExe,"fixture");File.WriteAllText(removal,"fixture");
                try{
                    check(InstallerChoices.Apply(setupState,setupExe,true,"en",setupKey)==0&&StartupRegistration.Enabled(setupKey)&&AppSettings.Load(setupState).autoStart&&AppSettings.Load(setupState).language=="en","installer choices enable startup and set the first language");
                    check(!StartupPreferences.ShouldPrompt(setupState),"installer choices stop the manager asking about the desktop shortcut again");
                    check(InstallerChoices.Apply(setupState,setupExe,false,"zh-CN",setupKey)==0&&!StartupRegistration.Enabled(setupKey)&&!AppSettings.Load(setupState).autoStart&&AppSettings.Load(setupState).language=="en","a later install clears startup without replacing the chosen language");
                    using(var key=Microsoft.Win32.Registry.CurrentUser.CreateSubKey(setupKey)){key.SetValue("InstallLocation",setupRoot+"\\");key.SetValue("UninstallString","\""+removal+"\"");}
                    check(String.Equals(Installation.Uninstaller(setupRoot,setupKey),removal,StringComparison.OrdinalIgnoreCase),"settings find the uninstaller of this installed copy");
                    check(Installation.Uninstaller(temp,setupKey)==null,"a portable copy elsewhere does not use another copy's uninstaller");
                    using(var key=Microsoft.Win32.Registry.CurrentUser.CreateSubKey(setupKey))key.SetValue("UninstallString","\""+setupExe+"\"");
                    check(Installation.Uninstaller(setupRoot,setupKey)==null,"a registered command that is not the uninstaller is ignored");
                }finally{Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(setupKey,false);}
                string fixtureKit = Path.Combine(temp, "中文 folder's"); Directory.CreateDirectory(fixtureKit);
                string fixtureOutput = Path.Combine(fixtureKit, "argument.txt");
                File.WriteAllText(Path.Combine(fixtureKit, "manager-open.ps1"), "param([string]$TargetName)\r\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'argument.txt'), $TargetName)\r\n", Encoding.UTF8);
                string literal = "测试'; throw 'must remain literal";
                using (var child = Actions.Start(fixtureKit, "open", literal)) {
                    if (!child.WaitForExit(12000)) { child.Kill(); throw new Exception("Local action fixture timed out"); }
                    check(child.ExitCode == 0 && File.ReadAllText(fixtureOutput) == literal, "real hidden PowerShell action preserves Unicode paths and literal arguments");
                }
                foreach (string action in new string[] { "connect", "stop" }) {
                    File.WriteAllText(Path.Combine(fixtureKit, Actions.Script(action)), "param([string]$TargetName,[long]$RequestTime)\r\nif($RequestTime -le 0){exit 1}\r\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'argument.txt'),$TargetName)\r\n", Encoding.UTF8);
                    using (var child = Actions.Start(fixtureKit, action, literal,"",fixtureKit)) {
                        if (!child.WaitForExit(12000)) { child.Kill(); throw new Exception("Local action fixture timed out"); }
                        check(child.ExitCode == 0 && File.ReadAllText(fixtureOutput) == literal, "real " + action + " dispatch preserves selected target literally");
                    }
                }
                File.WriteAllText(file,"[{\"name\":\"A\",\"url\":\"https://a.invalid\"},{\"name\":\"B\",\"url\":\"https://b.invalid\"}]");
                using (var form = new Manager(false,temp)) { form.Show(); Application.DoEvents(); check(form.TestIndependentButtons(), "waiting A leaves stop A and all B controls available"); }
                using (var form = new Manager(true)) { form.Show(); Application.DoEvents(); check(form.Visible && form.Controls.Count > 0, "real WinForms preview starts with no connector"); }
                DashboardTests.Run(temp, check);
                BackendRestart.Test(temp,check);
                SettingsTests.Run(temp,check);
                TrayTests.Run(temp,check);
                UpdateProgressTests.Run(temp,check);
                CloudCliTests.Run(temp,check);SshWebTests.Run(temp,check);CloudCliSetupTests.Run(temp,check);
                MotionTests.Run(temp,check);
                SshTests.Run(temp,check);
                ControlOrderTests.Run(temp,check);
                File.WriteAllText(output, new JavaScriptSerializer().Serialize(new { passed = checks.Count, failed = 0, skipped = 0, not_executed = new string[] { "real VPS connection", "existing production state", "manual end-user operation" }, nativeFrame = new { darkCaptionSetResult=DashboardTests.DarkCaptionResult, lightCaptionSetResult=DashboardTests.LightCaptionResult, requestedDarkCaptionColor=ColorTranslator.ToWin32(Palette.Create(true).Page), note="0 means Windows accepted the caption color; this is not a pixel-level visual check. Unsupported systems return a nonzero HRESULT or null." }, checks = checks }), Encoding.UTF8); return 0;
            } catch (Exception e) { File.WriteAllText(output, new JavaScriptSerializer().Serialize(new { passed = checks.Count, failed = 1, error = e.ToString(), checks = checks }), Encoding.UTF8); return 1; }
            finally {
                // Remove only files created by this test; never recursively
                // remove a computed path or any unexpected data in it.
                try {
                    foreach (var file in new string[] { "cloudpc-targets.json", "link-status.json" }) File.Delete(Path.Combine(temp, file));
                    string fixtureKit = Path.Combine(temp, "中文 folder's");
                    foreach (var file in new string[] { "manager-open.ps1", "argument.txt", "start.ps1", "stop.ps1", "control-order.txt" }) File.Delete(Path.Combine(fixtureKit, file));
                    if (Directory.Exists(fixtureKit)) Directory.Delete(fixtureKit, false);
                    Directory.Delete(temp, false);
                } catch { }
            }
        }
    }
}
