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

[assembly: System.Reflection.AssemblyTitle("Claude MCP 连接管理")]
[assembly: System.Reflection.AssemblyProduct("Claude MCP Portable Manager")]
[assembly: System.Reflection.AssemblyVersion("3.3.3.0")]
[assembly: System.Reflection.AssemblyFileVersion("3.3.3.0")]

namespace ClaudeMcp {
    internal sealed class Target {
        public string Name, Url, Mode, State, Detail;
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
        internal static string Caption(string state) {
            switch (state) {
                case "connected": return "已连接";
                case "waiting-login": return "等待网页登录";
                case "connecting": return "正在连接";
                case "configuring": return "正在配置 Claude";
                case "config-error": return "Claude 配置待处理";
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
                case "waiting-login": return "点击“打开云电脑”，在共享网页入口输入桌面密码。MCP 将共用这次登录。";
                case "configuring": return "正在通过现有流程检查云端 Claude 配置，请等待。";
                case "config-error": return "连接已建立，但 Claude 配置尚未确认。可查看日志，后台按原规则重试。";
                case "offline": return "后台正在等待网络或云端恢复。共享模式不会自动抢回失效的网页登录。";
                case "replaced": return "其他电脑或进程已接管连接。本机会停止竞争；需要时手动启动连接。";
                case "stale": return "本地状态超过 30 秒未更新，暂不确认连接有效。此界面不会主动探测 VPS。";
                case "stopped": return "此云电脑已停止。点击“启动连接”只连接这一台；其他云电脑保持原状。";
                default: return "点击“启动连接”运行现有向导；连接或密码错误会在向导中显示。";
            }
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
                    if (Convert.ToString(Get(data, "schema")) != "1" || entries == null || entries.Length > 100) throw new InvalidDataException();
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
            foreach (var item in (list ?? new object[0]).Take(100)) {
                var d = Obj(item); if (d == null) continue;
                string name = Text(Get(d, "name")), url = Text(Get(d, "url")); Uri parsed;
                if (name.Length < 1 || name.Length > 512 || !Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != "https" || !String.IsNullOrEmpty(parsed.UserInfo) || parsed.AbsolutePath != "/" || parsed.Query.Length != 0 || parsed.Fragment.Length != 0) { result.ReadError = true; continue; }
                var entry = Obj(Get(states, name));
                string state = !result.Running ? "stopped" : result.Stale ? "stale" : Text(Get(entry, "state"));
                IDictionary<string, object> control;
                if (controlled) {
                    bool enabled = controls.TryGetValue(name, out control) && Object.Equals(Get(control, "enabled"), true);
                    if (!enabled) state = "stopped";
                    else if (result.Running && !result.Stale && Text(Get(control, "revision")) != Text(Get(entry, "revision"))) state = "connecting";
                }
                string message = Text(Get(entry, "message"));
                result.Targets.Add(new Target { Name = name, Url = parsed.GetLeftPart(UriPartial.Authority), Mode = Text(Get(d, "authMode")) == "shared-browser" ? "共享网页登录" : "自动识别 / 旧版", State = state,
                    Detail = Detail(state) + (state == "connected" && message.Contains("兼容") ? "\r\n当前使用网页终端兼容通道。" : "") });
            }
            return result;
        }
    }
    internal static class Actions {
        internal static string Quote(string value) { return "'" + value.Replace("'", "''") + "'"; }
        internal static string Script(string action) {
            switch (action) {
                case "connect": return "start.ps1";
                case "add": return "add-cloudpc.ps1";
                case "stop": return "stop.ps1";
                case "open": return "manager-open.ps1";
                default: throw new ArgumentException("Unknown action");
            }
        }
        internal static string Command(string kit, string action, string name) {
            string command = "& " + Quote(Path.Combine(kit, Script(action)));
            if (action != "add") {
                if (String.IsNullOrWhiteSpace(name)) throw new ArgumentException("Select a cloud computer first");
                command += " -TargetName " + Quote(name);
                if (action == "connect" || action == "stop") command += " -RequestTime " + DateTime.UtcNow.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            return command;
        }
        internal static Process Start(string kit, string action, string name) {
            string script = Path.Combine(kit, Script(action));
            if (!File.Exists(script)) throw new FileNotFoundException("缺少文件，请完整解压便携包。", script);
            var command = Command(kit, action, name);
            string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            return Process.Start(new ProcessStartInfo(ps, "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = kit, WindowStyle = ProcessWindowStyle.Hidden
            });
        }
    }
    internal sealed class Manager : Form {
        readonly string root = AppDomain.CurrentDomain.BaseDirectory;
        readonly string kit = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
        readonly string stateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeLocalMcp");
        readonly bool preview;
        readonly DataGridView grid = new DataGridView();
        readonly Label status = new Label(), detail = new Label(), footer = new Label();
        readonly Button connect = new Button(), add = new Button(), stop = new Button(), open = new Button();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        sealed class PendingAction { internal Process Process; internal string Name, Action; }
        readonly List<PendingAction> children = new List<PendingAction>();
        List<Target> targets = new List<Target>();
        string signature = "";
        internal Manager(bool demo, string stateOverride = null) {
            if (stateOverride != null) stateDirectory = stateOverride;
            preview = demo; Text = "Claude MCP · 本机连接管理 · 3.3.3";
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Microsoft YaHei UI", 10F); BackColor = Color.FromArgb(245, 247, 251);
            ClientSize = new Size(990, 690); MinimumSize = new Size(860, 660); StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            var header = new Panel { Dock = DockStyle.Top, Height = 118, BackColor = Color.FromArgb(25, 42, 66) };
            header.Controls.Add(new Label { Text = "Claude MCP", Location = new Point(28, 18), Size = new Size(700, 42), ForeColor = Color.White, Font = new Font("Segoe UI", 23F, FontStyle.Bold) });
            header.Controls.Add(new Label { Text = "连接云电脑，让 Claude 使用这台 Windows 电脑的文件与工具", Location = new Point(30, 74), Size = new Size(900, 28), ForeColor = Color.FromArgb(196, 212, 232) });
            Controls.Add(header);
            var body = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26, 18, 26, 12), ColumnCount = 1, RowCount = 7 };
            body.RowStyles.Add(new RowStyle(SizeType.Absolute, 38)); body.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); body.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            body.RowStyles.Add(new RowStyle(SizeType.Absolute, 102)); body.RowStyles.Add(new RowStyle(SizeType.Absolute, 60)); body.RowStyles.Add(new RowStyle(SizeType.Absolute, 38)); body.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            status.Dock = DockStyle.Fill; status.Font = new Font(Font, FontStyle.Bold); body.Controls.Add(status, 0, 0);
            grid.Dock = DockStyle.Fill; grid.ReadOnly = true; grid.AllowUserToAddRows = false; grid.AllowUserToDeleteRows = false; grid.AllowUserToResizeRows = false;
            grid.MultiSelect = false; grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect; grid.RowHeadersVisible = false; grid.AutoGenerateColumns = false;
            grid.BackgroundColor = Color.White; grid.BorderStyle = BorderStyle.None; grid.EnableHeadersVisualStyles = false; grid.ColumnHeadersHeight = 38;
            grid.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(230, 236, 245), ForeColor = Color.FromArgb(42, 58, 78), Font = new Font(Font, FontStyle.Bold) };
            grid.DefaultCellStyle.Padding = new Padding(8, 3, 8, 3); grid.RowTemplate.Height = 40;
            grid.DefaultCellStyle.SelectionBackColor = Color.FromArgb(220, 235, 252); grid.DefaultCellStyle.SelectionForeColor = Color.FromArgb(25, 42, 66);
            grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "云电脑地址", FillWeight = 50 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "登录方式", FillWeight = 25 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "连接状态", FillWeight = 25 });
            grid.SelectionChanged += delegate { UpdateDetail(); UpdateButtons(); }; body.Controls.Add(grid, 0, 1);
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 11, 0, 0), WrapContents = false };
            SetupButton(connect, "启动连接", Color.FromArgb(35, 105, 190), Color.White); SetupButton(open, "打开云电脑", Color.White, Color.FromArgb(35, 80, 130));
            SetupButton(add, "添加 / 修改", Color.White, Color.FromArgb(35, 80, 130)); SetupButton(stop, "停止连接", Color.White, Color.FromArgb(170, 65, 65));
            buttons.Controls.AddRange(new Control[] { connect, open, add, stop }); body.Controls.Add(buttons, 0, 2);
            connect.Click += delegate { Launch("connect"); }; open.Click += delegate { Launch("open"); }; add.Click += delegate { Launch("add"); };
            stop.Click += delegate { var t = Selected; if (t != null && MessageBox.Show(this, "只停止这台云电脑的 MCP 连接？\r\n" + t.Url + "\r\n\r\n其他云电脑不受影响。", "停止所选连接", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK) Launch("stop"); };
            detail.Dock = DockStyle.Fill; detail.BackColor = Color.White; detail.Padding = new Padding(14, 10, 14, 8); detail.ForeColor = Color.FromArgb(65, 82, 104); body.Controls.Add(detail, 0, 3);
            body.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "权限说明：连接后，Claude 可按当前 Windows 账户权限读写文件、运行命令和操作桌面。\r\n启动／停止只作用于选中的云电脑；支持多台同时连接。本界面不显示密码。", ForeColor = Color.FromArgb(125, 86, 45), Padding = new Padding(0, 10, 0, 0) }, 0, 4);
            var links = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            AddLink(links, "查看日志文件夹", delegate { OpenLocal(stateDirectory); }); AddLink(links, "使用说明", delegate { OpenLocal(Path.Combine(root, "docs", "桌面版使用说明.md")); });
            AddLink(links, "程序文件夹", delegate { OpenLocal(root); }); body.Controls.Add(links, 0, 5);
            footer.Dock = DockStyle.Fill; footer.ForeColor = Color.FromArgb(100, 114, 134); footer.Text = "关闭窗口保留连接；停止所选项后，重启电脑也不会自动连接它。"; body.Controls.Add(footer, 0, 6);
            Controls.Add(body); body.BringToFront();
            timer.Interval = 2000; timer.Tick += delegate { RefreshState(); }; timer.Start();
            FormClosed += delegate { timer.Stop(); timer.Dispose(); foreach (var p in children) p.Process.Dispose(); };
            RefreshState();
        }
        void SetupButton(Button b, string text, Color back, Color fore) { b.Text = text; b.Size = new Size(138, 36); b.Margin = new Padding(0, 0, 12, 0); b.BackColor = back; b.ForeColor = fore; b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderColor = Color.FromArgb(208, 220, 235); }
        void AddLink(FlowLayoutPanel panel, string title, Action action) { var link = new LinkLabel { Text = title, AutoSize = true, Margin = new Padding(0, 10, 24, 0), LinkColor = Color.FromArgb(35, 105, 190) }; link.LinkClicked += delegate { if (!preview) action(); }; panel.Controls.Add(link); }
        Target Selected { get { return grid.SelectedRows.Count > 0 ? grid.SelectedRows[0].Tag as Target : null; } }
        void UpdateDetail() { var t = Selected; detail.Text = t == null ? "还没有选择云电脑。点击“添加 / 修改”保存地址，再启动连接。" : t.Url + "\r\n" + t.Detail; }
        void OpenLocal(string path) { try { if (!File.Exists(path) && !Directory.Exists(path)) { MessageBox.Show(this, "该位置尚不存在。首次连接后会生成日志。", Text); return; } Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { MessageBox.Show(this, "无法打开，请在资源管理器中查看程序文件夹。", Text); } }
        void Launch(string action) {
            if (preview) return;
            if (action != "add" && Selected == null) return;
            try { string name = Selected == null ? "" : Selected.Name; children.Add(new PendingAction { Process = Actions.Start(kit, action, name), Name = name, Action = action }); RefreshState(); }
            catch { MessageBox.Show(this, "无法打开操作向导。请确认便携包完整，且 Windows PowerShell 可以运行。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
        void RefreshState() {
            children.RemoveAll(delegate(PendingAction p) { try { if (!p.Process.HasExited) return false; } catch { } p.Process.Dispose(); return true; });
            Snapshot s = preview ? Demo() : LocalState.Load(stateDirectory);
            status.Text = preview ? "界面预览 · 使用模拟状态，未连接 VPS" : s.ReadError ? "本地设置暂时无法完整读取，将自动刷新" : s.Stale ? "后台状态未更新，请检查连接" : s.Running ? "后台正在运行 · 已配置 " + s.Targets.Count + " 台 · 可分别启动和停止" : "后台尚未运行 · 打开本界面不会自动连接";
            status.ForeColor = s.Running && !s.Stale ? Color.FromArgb(35, 125, 85) : Color.FromArgb(90, 104, 125);
            string selected = Selected == null ? "" : Selected.Name;
            string next = String.Join("\n", s.Targets.Select(t => t.Name + "|" + t.Url + "|" + t.Mode + "|" + t.State + "|" + t.Detail));
            targets = s.Targets;
            if (signature != next) {
                signature = next; grid.Rows.Clear();
                foreach (var t in targets) { int i = grid.Rows.Add(t.Url, t.Mode, LocalState.Caption(t.State)); grid.Rows[i].Tag = t; if (t.Name == selected) grid.Rows[i].Selected = true; }
                UpdateDetail();
            }
            UpdateDetail();
            UpdateButtons();
        }
        void UpdateButtons() {
            var t = Selected;
            bool selected = !preview && t != null;
            connect.Enabled = selected && !children.Any(p => p.Name == t.Name && p.Action == "connect") && t.State != "connected";
            stop.Enabled = selected && !children.Any(p => p.Name == t.Name && p.Action == "stop");
            open.Enabled = selected;
            add.Enabled = !preview && !children.Any(p => p.Action == "add");
        }
        internal bool TestIndependentButtons() {
            if (grid.Rows.Count != 2) return false;
            grid.Rows[0].Selected = true;
            var process = Process.GetCurrentProcess();
            var action = new PendingAction { Process = process, Name = Selected.Name, Action = "connect" };
            try {
                children.Add(action); UpdateButtons();
                bool a = !connect.Enabled && stop.Enabled;
                grid.Rows[1].Selected = true; UpdateButtons();
                return a && connect.Enabled && stop.Enabled && open.Enabled;
            } finally { children.Remove(action); process.Dispose(); }
        }
        internal static Snapshot Demo() { var s = new Snapshot { Running = true }; s.Targets.Add(new Target { Name = "preview-a", Url = "https://desktop1.example.com", Mode = "共享网页登录", State = "connected", Detail = LocalState.Detail("connected") }); s.Targets.Add(new Target { Name = "preview-b", Url = "https://desktop2.example.com", Mode = "共享网页登录", State = "stopped", Detail = LocalState.Detail("stopped") }); return s; }
    }
    internal static class Program {
        [STAThread] static int Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 2 && args[0] == "--self-test") return SelfTest(args[1]);
            if (args.Length == 2 && args[0] == "--preview") {
                using (var form = new Manager(true)) { form.Show(); Application.DoEvents(); using (var bmp = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bmp, new Rectangle(Point.Empty, bmp.Size)); bmp.Save(Path.GetFullPath(args[1]), System.Drawing.Imaging.ImageFormat.Png); } }
                return 0;
            }
            if (args.Length == 2 && args[0] == "--preview-shortcut") {
                using (var form = new ShortcutPrompt()) { form.Show(); Application.DoEvents(); using (var bmp = new Bitmap(form.Width,form.Height)) { form.DrawToBitmap(bmp,new Rectangle(Point.Empty,bmp.Size)); bmp.Save(Path.GetFullPath(args[1]),System.Drawing.Imaging.ImageFormat.Png); } }
                return 0;
            }
            if (args.Length != 0) return 64;
            string account = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string key; using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(account.ToLowerInvariant()))).Replace("-", "").Substring(0, 20);
            bool created;
            using (var mutex = new Mutex(true, "Local\\ClaudeMcpManager-" + key, out created)) {
                if (!created) { MessageBox.Show("连接管理界面已经打开，请从任务栏切换。", "Claude MCP"); return 0; }
                try { ShortcutPrompt.AskBeforeManager(); Application.Run(new Manager(false)); return 0; }
                catch { MessageBox.Show("界面无法打开，请确认便携包完整。原有 BAT 入口仍可使用。", "Claude MCP", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
                finally { mutex.ReleaseMutex(); }
            }
        }
        static int SelfTest(string output) {
            var checks = new List<string>(); string temp = Path.Combine(Path.GetTempPath(), "claude-mcp-manager-test-" + Guid.NewGuid().ToString("N"));
            try {
                Directory.CreateDirectory(temp);
                Action<bool, string> check = (ok, name) => { if (!ok) throw new Exception(name); checks.Add(name); };
                check(LocalState.Load(temp).Targets.Count == 0, "empty state does not create configuration");
                ShortcutTests.Run(temp,check);
                string file = Path.Combine(temp, "cloudpc-targets.json");
                File.WriteAllText(file, "[{\"name\":\"demo\",\"url\":\"https://desktop.example.com\",\"password\":\"DO-NOT-DISPLAY\",\"authMode\":\"shared-browser\"}]", Encoding.UTF8);
                var s = LocalState.Load(temp); check(s.Targets.Count == 1 && s.Targets[0].State == "stopped", "saved target without backend is stopped");
                check(!s.Targets[0].Detail.Contains("DO-NOT-DISPLAY"), "password is not part of view model");
                File.WriteAllText(Path.Combine(temp, "link-status.json"), "{\"pid\":2147483647,\"targets\":{\"demo\":{\"state\":\"connected\"}}}");
                check(LocalState.Load(temp).Targets[0].State == "stopped", "dead PID never reports connected");
                File.WriteAllText(file, "[{\"name\":\"bad\",\"url\":\"https://user:secret@example.com\"}]"); check(LocalState.Load(temp).Targets.Count == 0, "credential-bearing URL is rejected");
                File.WriteAllText(file, "{"); check(LocalState.Load(temp).ReadError, "partial JSON is safe and retriable");
                check(Actions.Quote("a'b") == "'a''b'", "PowerShell arguments escape apostrophes");
                check(Actions.Command("C:\\kit's folder", "open", "x'; exit; '").Contains("-TargetName 'x''; exit; '''"), "target cannot inject PowerShell");
                foreach (string action in new string[] { "connect", "stop" }) {
                    check(Actions.Command("C:\\kit", action, "selected-A").Contains("-TargetName 'selected-A' -RequestTime "), action + " always passes selected target and request ordering");
                    bool empty = false; try { Actions.Command("C:\\kit", action, ""); } catch (ArgumentException) { empty = true; }
                    check(empty, action + " with no selection cannot reach global BAT behaviour");
                }
                bool rejected = false; try { Actions.Script("arbitrary-command"); } catch (ArgumentException) { rejected = true; } check(rejected, "actions are a fixed allowlist");
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
                    using (var child = Actions.Start(fixtureKit, action, literal)) {
                        if (!child.WaitForExit(12000)) { child.Kill(); throw new Exception("Local action fixture timed out"); }
                        check(child.ExitCode == 0 && File.ReadAllText(fixtureOutput) == literal, "real " + action + " dispatch preserves selected target literally");
                    }
                }
                File.WriteAllText(file,"[{\"name\":\"A\",\"url\":\"https://a.invalid\"},{\"name\":\"B\",\"url\":\"https://b.invalid\"}]");
                using (var form = new Manager(false,temp)) { form.Show(); Application.DoEvents(); check(form.TestIndependentButtons(), "waiting A leaves stop A and all B controls available"); }
                using (var form = new Manager(true)) { form.Show(); Application.DoEvents(); check(form.Visible && form.Controls.Count > 0, "real WinForms preview starts with no connector"); }
                File.WriteAllText(output, new JavaScriptSerializer().Serialize(new { passed = checks.Count, failed = 0, skipped = 0, not_executed = new string[] { "real VPS connection", "existing production state", "manual end-user operation" }, checks = checks }), Encoding.UTF8); return 0;
            } catch (Exception e) { File.WriteAllText(output, new JavaScriptSerializer().Serialize(new { passed = checks.Count, failed = 1, error = e.Message + " / " + e.GetBaseException().Message, checks = checks }), Encoding.UTF8); return 1; }
            finally {
                // Remove only files created by this test; never recursively
                // remove a computed path or any unexpected data in it.
                try {
                    foreach (var file in new string[] { "cloudpc-targets.json", "link-status.json" }) File.Delete(Path.Combine(temp, file));
                    string fixtureKit = Path.Combine(temp, "中文 folder's");
                    foreach (var file in new string[] { "manager-open.ps1", "argument.txt", "start.ps1", "stop.ps1" }) File.Delete(Path.Combine(fixtureKit, file));
                    if (Directory.Exists(fixtureKit)) Directory.Delete(fixtureKit, false);
                    Directory.Delete(temp, false);
                } catch { }
            }
        }
    }
}
