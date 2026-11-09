using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CMCP {
    // What app/mcp-tools-cli.mjs reports: the built-in groups switched on for this computer and
    // the tools in the mcp-tools folder. One set of switches applies to every connection.
    internal sealed class ToolInfo {
        internal string Id,Name,Description,Version,Homepage,Log,DescribeZh,DescribeEn,RuntimeZh,RuntimeEn;
        internal bool Enabled,Approved;
        internal string[] Errors=new string[0],Warnings=new string[0],MissingSecrets=new string[0],Tools,Recent=new string[0];
        internal string Describe{get{return L.Language=="en"?DescribeEn:DescribeZh;}}
        internal string Runtime{get{return L.Language=="en"?RuntimeEn:RuntimeZh;}}
    }
    internal sealed class ToolSnapshot {
        internal readonly Dictionary<string,bool> Groups=new Dictionary<string,bool>();
        internal readonly List<ToolInfo> Tools=new List<ToolInfo>();
        internal string Root,Blender,Error;internal bool BlenderOfferDone;internal int IdleMinutes=30;
        static string S(IDictionary<string,object> d,string key){object v;return d!=null&&d.TryGetValue(key,out v)&&v!=null?Convert.ToString(v):null;}
        static bool B(IDictionary<string,object> d,string key){object v;return d!=null&&d.TryGetValue(key,out v)&&v is bool&&(bool)v;}
        static IDictionary<string,object> O(IDictionary<string,object> d,string key){object v;return d!=null&&d.TryGetValue(key,out v)?v as IDictionary<string,object>:null;}
        static string[] A(IDictionary<string,object> d,string key,Func<object,string> map){object v;var list=d!=null&&d.TryGetValue(key,out v)?v as object[]:null;return list==null?null:list.Select(map).Where(x=>x!=null).ToArray();}
        internal static ToolSnapshot Parse(string json){
            var snapshot=new ToolSnapshot();var data=new JavaScriptSerializer{MaxJsonLength=8*1024*1024}.DeserializeObject(json) as IDictionary<string,object>;
            if(data==null)throw new FormatException("Invalid tool status");
            if(S(data,"error")!=null){snapshot.Error=S(data,"error");return snapshot;}
            snapshot.Root=S(data,"root");object idle;if(data.TryGetValue("idleMinutes",out idle)&&idle is int)snapshot.IdleMinutes=(int)idle;
            var groups=O(data,"groups");if(groups!=null)foreach(var pair in groups)if(pair.Value is bool)snapshot.Groups[pair.Key]=(bool)pair.Value;
            var blender=O(data,"blender");snapshot.Blender=S(blender,"detected");snapshot.BlenderOfferDone=B(blender,"offerDone");
            object[] tools=null;object raw;if(data.TryGetValue("tools",out raw))tools=raw as object[];
            foreach(var item in tools??new object[0]){
                var t=item as IDictionary<string,object>;if(t==null)continue;var describe=O(t,"describe");var runtime=O(t,"runtime");
                snapshot.Tools.Add(new ToolInfo{Id=S(t,"id"),Name=S(t,"name")??S(t,"id"),Description=S(t,"description")??"",Version=S(t,"version"),Homepage=S(t,"homepage"),Log=S(t,"log"),
                    Enabled=B(t,"enabled"),Approved=B(t,"approved"),Errors=A(t,"errors",Convert.ToString)??new string[0],
                    Warnings=A(t,"warnings",w=>{var d=w as IDictionary<string,object>;return d==null?null:S(d,"code");})??new string[0],
                    MissingSecrets=A(t,"missingSecrets",Convert.ToString)??new string[0],Tools=A(t,"tools",Convert.ToString),Recent=A(t,"recent",Convert.ToString)??new string[0],
                    DescribeZh=S(describe,"zh"),DescribeEn=S(describe,"en"),RuntimeZh=S(runtime,"zh"),RuntimeEn=S(runtime,"en")});
            }
            return snapshot;
        }
    }
    internal interface IToolBackend {
        ToolSnapshot Status();
        void SetGroup(string group,bool on);
        void SetTool(string id,bool on);
        void SetIdle(int minutes);
        void BlenderOfferDone();
        void Refresh();
        string Import(string text,bool apply);
        void Remove(string id);
    }
    // Runs app/mcp-tools-cli.mjs with the bundled node; pasted text goes through stdin only.
    internal sealed class CliToolBackend : IToolBackend {
        readonly string kit,state;
        internal CliToolBackend(string kit,string state){this.kit=kit;this.state=state;}
        string Run(string input,params string[] args){
            var start=new ProcessStartInfo(Path.Combine(kit,"runtime","node.exe")){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=kit,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8};
            start.Arguments=String.Join(" ",new[]{Path.Combine(kit,"mcp-tools-cli.mjs")}.Concat(args).Concat(new[]{"--state",state}).Select(SshChannel.Quote));
            start.EnvironmentVariables["CMCP_STATE_DIR"]=state;
            using(var process=Process.Start(start)){
                var error=new StringBuilder();process.ErrorDataReceived+=delegate(object s,DataReceivedEventArgs e){if(e.Data!=null&&error.Length<4096)error.AppendLine(e.Data);};process.BeginErrorReadLine();
                var bytes=new UTF8Encoding(false).GetBytes(input??"");process.StandardInput.BaseStream.Write(bytes,0,bytes.Length);process.StandardInput.Close();
                string output=process.StandardOutput.ReadToEnd();
                if(!process.WaitForExit(60000)){try{process.Kill();}catch{}throw new TimeoutException("Tool command timed out");}
                var line=output.Split('\n').Select(l=>l.Trim()).LastOrDefault(l=>l.StartsWith("{"));
                if(line==null)throw new InvalidOperationException(error.Length>0?error.ToString():"No reply from the tool command");
                var data=new JavaScriptSerializer{MaxJsonLength=8*1024*1024}.DeserializeObject(line) as IDictionary<string,object>;object message;
                if(data!=null&&data.TryGetValue("error",out message)&&message!=null)throw new InvalidOperationException(Convert.ToString(message));
                return line;
            }
        }
        public ToolSnapshot Status(){return ToolSnapshot.Parse(Run(null,"status"));}
        public void SetGroup(string group,bool on){Run(null,"set","--group",group,on?"--on":"--off");}
        public void SetTool(string id,bool on){Run(null,"set","--tool",id,on?"--on":"--off");}
        public void SetIdle(int minutes){Run(null,"set","--idle",minutes.ToString());}
        public void BlenderOfferDone(){Run(null,"set","--blender-offer-done");}
        public void Refresh(){Run(null,"refresh");}
        public string Import(string text,bool apply){return apply?Run(text,"import","--apply"):Run(text,"import");}
        public void Remove(string id){Run(null,"remove","--tool",id);}
    }

    internal sealed partial class SettingsPage {
        internal IToolBackend Tools;
        internal Func<string,bool> ConfirmTool=text=>MessageBox.Show(text,"CMCP",MessageBoxButtons.YesNo,MessageBoxIcon.Information,MessageBoxDefaultButton.Button2)==DialogResult.Yes;
        internal Func<string> AskImport=()=>ToolImportDialog.Ask();
        internal Action<string> OpenPath=path=>{try{Process.Start(new ProcessStartInfo(path){UseShellExecute=true});}catch{}};
        ToolSnapshot toolSnapshot;bool toolsLoading;
        static readonly string[][] GroupRows={
            new[]{"files","文件读写","读写允许的本机文件夹，以及与 VPS 之间传输文件。"},
            new[]{"commands","命令执行","在本机运行 PowerShell、CMD 或程序。"},
            new[]{"processes","后台任务","启动、查看和停止本机后台进程。"},
            new[]{"toolchains","开发工具链","查找本机的 C/C++、Android、Web、Python、Java、Git、Docker、WSL 等工具。"},
            new[]{"desktop","桌面操作","截图、打开网页、模拟鼠标键盘。"},
            new[]{"blender","Blender","通过 Blender 插件操作本机打开的 Blender。"},
        };
        // Reads the tool state off the window thread, then rebuilds this page if it is still shown.
        internal void LoadTools(){
            if(Tools==null||toolsLoading)return;toolsLoading=true;
            var backend=Tools;
            ThreadPool.QueueUserWorkItem(delegate{
                ToolSnapshot snapshot;try{snapshot=backend.Status();}catch(Exception e){snapshot=new ToolSnapshot{Error=e.Message};}
                try{BeginInvoke((Action)delegate{toolsLoading=false;toolSnapshot=snapshot;if(page==ToolsIndex)Build();});}catch{toolsLoading=false;}
            });
        }
        internal ToolSnapshot ToolState{get{return toolSnapshot;}}
        internal bool ToolsLoading{get{return toolsLoading;}}
        // The command runs off the window thread; the page reloads when it has finished.
        void ToolAction(Action work,string done){
            if(Tools==null)return;
            ThreadPool.QueueUserWorkItem(delegate{
                string error=null;try{work();}catch(Exception e){error=e.Message;}
                try{BeginInvoke((Action)delegate{if(error==null)SetFeedback(done,false);else SetFeedback(L.Text("操作未完成：")+error,true);LoadTools();});}catch{}
            });
        }
        void BuildTools(){
            if(Tools==null){var none=AddSection("本机工具");AddRow(none,"预览模式","预览模式下不读取本机工具。",null);return;}
            if(toolSnapshot==null){var waiting=AddSection("本机工具");AddRow(waiting,"正在读取本机工具…",null,null);LoadTools();return;}
            if(toolSnapshot.Error!=null){var failed=AddSection("本机工具");AddRow(failed,()=>L.Text("无法读取本机工具"),()=>toolSnapshot.Error,Command("重试",delegate{toolSnapshot=null;Build();}));return;}
            var builtin=AddSection("内置工具");
            foreach(var row in GroupRows){
                string group=row[0];bool on;toolSnapshot.Groups.TryGetValue(group,out on);
                var toggle=new ToggleSwitch{Text=L.Text(row[1]),Checked=on,Colors=colors,Size=new Size(48,30)};
                toggle.Click+=delegate{bool next=toggle.Checked;ToolAction(()=>Tools.SetGroup(group,next),next?"已开启，正在通知已连接的 Claude。":"已关闭，正在通知已连接的 Claude。");};
                AddRow(builtin,()=>L.Text(row[1]),()=>group=="blender"?L.Text(row[2])+" "+(toolSnapshot.Blender!=null?L.Text("已检测到 Blender：")+toolSnapshot.Blender:L.Text("没有检测到本机安装的 Blender。")):L.Text(row[2]),toggle);
            }
            var custom=AddSection("自定义工具");
            if(toolSnapshot.Tools.Count==0)AddRow(custom,"还没有自定义工具","粘贴 GitHub 上 MCP 服务器给出的配置即可添加；也可以照 mcp-tools 文件夹里的 AGENT.md 自己编写。",null);
            foreach(var tool in toolSnapshot.Tools){
                var item=tool;
                var actions=new ToolRowActions();
                actions.Log=Command("日志",delegate{if(File.Exists(item.Log))OpenPath(item.Log);else SetFeedback("这个工具还没有日志。",false);});
                actions.Remove=Danger("删除",delegate{
                    if(!ConfirmTool(String.Format(L.Text("删除 {0}？\r\n\r\n文件夹会移到 mcp-tools 里以 .removed- 开头的文件夹，可以手动恢复。"),item.Name)))return;
                    ToolAction(()=>Tools.Remove(item.Id),"已删除，正在通知已连接的 Claude。");});
                actions.Toggle=new ToggleSwitch{Text=item.Name,Checked=item.Enabled&&item.Approved,Colors=colors,Size=new Size(48,30),Enabled=item.Errors.Length==0};
                actions.Toggle.Click+=delegate{
                    bool next=actions.Toggle.Checked;
                    if(next&&!item.Approved&&!ConfirmTool(item.Describe+"\r\n\r\n"+L.Text("开启这个工具吗？"))){actions.Toggle.Checked=false;return;}
                    ToolAction(()=>Tools.SetTool(item.Id,next),next?"已开启，正在通知已连接的 Claude。":"已关闭，正在通知已连接的 Claude。");};
                actions.Arrange();
                AddRow(custom,()=>item.Name+(item.Version!=null?" "+item.Version:""),()=>ToolDetail(item),actions);
            }
            var manage=AddSection("管理");
            AddRow(manage,"添加工具","粘贴 MCP 服务器的配置（例如 README 里 Claude Desktop 的 mcpServers 片段）。添加后默认关闭。",Command("添加",delegate{
                string text=AskImport();if(String.IsNullOrWhiteSpace(text))return;
                string preview;
                try{preview=ImportSummary(Tools.Import(text,false));}catch(Exception e){SetFeedback(L.Text("操作未完成：")+e.Message,true);return;}
                if(!ConfirmTool(preview+"\r\n\r\n"+L.Text("添加到 mcp-tools 文件夹吗？添加后默认关闭。")))return;
                ToolAction(()=>Tools.Import(text,true),"已添加。打开开关后 Claude 才能使用。");
            }));
            AddRow(manage,"刷新工具列表","重新读取 mcp-tools 文件夹和每个已开启工具的工具列表，并通知已连接的 Claude。",Command("刷新",delegate{ToolAction(()=>Tools.Refresh(),"已请求刷新。");}));
            var idle=new DropdownField(new[]{new KeyValuePair<string,string>("10","10 分钟"),new KeyValuePair<string,string>("30","30 分钟"),new KeyValuePair<string,string>("120","2 小时"),new KeyValuePair<string,string>("0","从不")}){Font=sheet.Font,Size=new Size(150,36),Colors=colors};
            idle.Chosen+=key=>ToolAction(()=>Tools.SetIdle(Int32.Parse(key)),"设置已保存。");
            refresh.Add(delegate{idle.Value=new[]{10,30,120,0}.Contains(toolSnapshot.IdleMinutes)?toolSnapshot.IdleMinutes.ToString():"30";idle.AccessibleName=L.Text("空闲后停止");idle.Invalidate();});
            AddRow(manage,"空闲后停止","第三方工具多久没有被调用就停止；下次调用时会自动重新启动。",idle);
            AddRow(manage,"mcp-tools 文件夹","每个工具一个子文件夹。更新和卸载 CMCP 都会保留它。",Command("打开",delegate{if(toolSnapshot.Root!=null){Directory.CreateDirectory(toolSnapshot.Root);OpenPath(toolSnapshot.Root);}}));
        }
        static string ToolDetail(ToolInfo t){
            var parts=new List<string>{t.Description};
            if(t.Errors.Length>0)parts.Add(L.Text("无法使用：")+String.Join("；",t.Errors));
            else if(t.Runtime!=null)parts.Add(t.Runtime);
            else if(t.MissingSecrets.Length>0)parts.Add(L.Text("缺少密钥：")+String.Join(", ",t.MissingSecrets.Select(s=>s.Substring(s.IndexOf(':')+1))));
            else if(t.Enabled&&t.Approved)parts.Add(t.Tools!=null?String.Format(L.Text("已开启，{0} 个工具"),t.Tools.Length):L.Text("已开启，第一次使用时读取工具列表"));
            if(t.Warnings.Contains("UNPINNED"))parts.Add(L.Text("未固定版本：每次启动可能变成新版本。"));
            if(t.Warnings.Contains("SECRET_IN_MANIFEST"))parts.Add(L.Text("清单里可能写了密钥，请改为 {\"secret\": true}。"));
            return String.Join("  ·  ",parts.Where(p=>!String.IsNullOrEmpty(p)));
        }
        static string ImportSummary(string json){
            var data=new JavaScriptSerializer().DeserializeObject(json) as IDictionary<string,object>;object raw;var lines=new List<string>();
            if(data!=null&&data.TryGetValue("items",out raw))foreach(var entry in (raw as object[])??new object[0]){
                var item=entry as IDictionary<string,object>;if(item==null)continue;
                var describe=item["describe"] as IDictionary<string,object>;object errors;
                lines.Add(Convert.ToString(item["id"])+": "+(describe==null?"":Convert.ToString(describe[L.Language=="en"?"en":"zh"])));
                if(item.TryGetValue("errors",out errors)&&((object[])errors).Length>0)lines.Add("  "+String.Join("; ",((object[])errors).Select(Convert.ToString)));
                object warnings;if(item.TryGetValue("warnings",out warnings)&&((object[])warnings).OfType<IDictionary<string,object>>().Any(w=>Convert.ToString(w["code"])=="UNPINNED"))lines.Add("  "+L.Text("未固定版本：每次启动可能变成新版本。"));
            }
            return String.Join("\r\n",lines);
        }
    }
    // Log and delete buttons beside a tool's switch, laid out as one row control.
    internal sealed class ToolRowActions : Panel {
        internal ModernButton Log,Remove;internal ToggleSwitch Toggle;
        internal void Arrange(){
            Controls.AddRange(new Control[]{Log,Remove,Toggle});
            foreach(var b in new[]{Log,Remove})b.Size=new Size(Math.Max(64,TextRenderer.MeasureText(L.Text(b.Text),b.Font).Width+28),34);
            Log.Location=new Point(0,2);Remove.Location=new Point(Log.Right+8,2);Toggle.Location=new Point(Remove.Right+12,4);
            Size=new Size(Toggle.Right,38);
        }
    }
    // The paste box for a server's Claude Desktop snippet.
    internal static class ToolImportDialog {
        internal static string Ask(){
            using(var form=new Form{Text=L.Text("添加工具"),StartPosition=FormStartPosition.CenterParent,Size=new Size(620,420),MinimizeBox=false,MaximizeBox=false,ShowInTaskbar=false,Font=UiFont.Points(10F)}){
                var hint=new Label{Text=L.Text("粘贴 MCP 服务器的配置，例如 {\"mcpServers\": {\"blender\": {\"command\": \"uvx\", \"args\": [\"mcp-for-blender\"]}}}"),Dock=DockStyle.Top,Height=48,Padding=new Padding(8)};
                var box=new TextBox{Multiline=true,ScrollBars=ScrollBars.Vertical,Dock=DockStyle.Fill,Font=new Font(FontFamily.GenericMonospace,10F),AcceptsReturn=true,AcceptsTab=false};
                var buttons=new FlowLayoutPanel{Dock=DockStyle.Bottom,Height=44,FlowDirection=FlowDirection.RightToLeft,Padding=new Padding(6)};
                var ok=new Button{Text=L.Text("下一步"),DialogResult=DialogResult.OK,AutoSize=true};var cancel=new Button{Text=L.Text("取消"),DialogResult=DialogResult.Cancel,AutoSize=true};
                buttons.Controls.AddRange(new Control[]{cancel,ok});form.Controls.Add(box);form.Controls.Add(hint);form.Controls.Add(buttons);form.CancelButton=cancel;
                return form.ShowDialog()==DialogResult.OK?box.Text:null;
            }
        }
    }
    // Offer the Blender tools once, when Blender is installed and the group is still off.
    internal static class BlenderOffer {
        internal static void Check(Control owner,IToolBackend backend){
            if(backend==null)return;
            ThreadPool.QueueUserWorkItem(delegate{
                ToolSnapshot snapshot;try{snapshot=backend.Status();}catch{return;}
                bool on;snapshot.Groups.TryGetValue("blender",out on);
                if(snapshot.Error!=null||snapshot.Blender==null||snapshot.BlenderOfferDone||on)return;
                try{owner.BeginInvoke((Action)delegate{
                    if(owner.IsDisposed||!owner.Visible)return;
                    var answer=MessageBox.Show(owner,L.Text("检测到这台电脑安装了 Blender。\r\n\r\n要让 VPS 上的 Claude 通过 CMCP 操作本机的 Blender 吗？以后可以在 设置 > 工具 中更改。"),"CMCP",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2);
                    ThreadPool.QueueUserWorkItem(delegate{try{if(answer==DialogResult.Yes)backend.SetGroup("blender",true);backend.BlenderOfferDone();}catch{}});
                });}catch{}
            });
        }
    }

    internal sealed class FakeToolBackend : IToolBackend {
        internal readonly ToolSnapshot State=new ToolSnapshot{Root=Path.Combine(Path.GetTempPath(),"cmcp-fake-mcp-tools")};
        internal readonly List<string> Calls=new List<string>();
        internal FakeToolBackend(){foreach(var g in new[]{"files","commands","processes","toolchains","desktop"})State.Groups[g]=true;State.Groups["blender"]=false;}
        public ToolSnapshot Status(){Calls.Add("status");return State;}
        public void SetGroup(string group,bool on){Calls.Add("group "+group+" "+on);State.Groups[group]=on;}
        public void SetTool(string id,bool on){Calls.Add("tool "+id+" "+on);var t=State.Tools.First(x=>x.Id==id);t.Enabled=on;if(on)t.Approved=true;}
        public void SetIdle(int minutes){Calls.Add("idle "+minutes);State.IdleMinutes=minutes;}
        public void BlenderOfferDone(){Calls.Add("offer");State.BlenderOfferDone=true;}
        public void Refresh(){Calls.Add("refresh");}
        public string Import(string text,bool apply){Calls.Add("import "+apply);return "{\"items\":[{\"id\":\"blender_mcp\",\"describe\":{\"zh\":\"运行 uvx\",\"en\":\"runs uvx\"},\"errors\":[],\"warnings\":[]}]}";}
        public void Remove(string id){Calls.Add("remove "+id);State.Tools.RemoveAll(t=>t.Id==id);}
    }
    internal static class ToolsPageTests {
        static void Pump(Func<bool> done){var clock=Stopwatch.StartNew();while(!done()&&clock.ElapsedMilliseconds<5000){Application.DoEvents();Thread.Sleep(5);}}
        internal static void Run(string directory,Action<bool,string> check){
            var parsed=ToolSnapshot.Parse("{\"root\":\"F:\\\\CMCP\\\\mcp-tools\",\"groups\":{\"files\":true,\"blender\":false},\"idleMinutes\":0,\"blender\":{\"detected\":\"C:\\\\Blender\\\\blender.exe\",\"offerDone\":false},\"tools\":[{\"id\":\"gh\",\"name\":\"GitHub\",\"enabled\":true,\"approved\":true,\"errors\":[],\"warnings\":[{\"code\":\"UNPINNED\"}],\"missingSecrets\":[\"env:TOKEN\"],\"tools\":[\"gh__a\",\"gh__b\"],\"describe\":{\"zh\":\"中\",\"en\":\"en\"},\"runtime\":null}]}");
            check(parsed.Groups["files"]&&!parsed.Groups["blender"]&&parsed.IdleMinutes==0&&parsed.Blender==@"C:\Blender\blender.exe"&&parsed.Tools[0].Tools.Length==2&&parsed.Tools[0].Warnings.Contains("UNPINNED")&&parsed.Tools[0].MissingSecrets[0]=="env:TOKEN","tool status from the command line parses groups, tools, secrets and warnings");
            check(ToolSnapshot.Parse("{\"error\":\"broken\"}").Error=="broken","a tool command error is reported, not thrown");
            using(var form=new Manager(true)){
                form.ClientSize=new Size(760,560);form.Show();Application.DoEvents();form.OpenSettings();Application.DoEvents();
                var fake=new FakeToolBackend();fake.State.Tools.Add(new ToolInfo{Id="blender_mcp",Name="MCP for Blender",Description="Blender",DescribeZh="会运行 uvx",DescribeEn="runs uvx"});
                fake.State.Tools.Add(new ToolInfo{Id="broken",Name="Broken",Description="x",Errors=new[]{"schema must be 1"}});
                var page=form.Settings;page.Tools=fake;var asked=new List<string>();bool answer=false;page.ConfirmTool=text=>{asked.Add(text);return answer;};
                page.ShowTools();Pump(()=>page.ToolState!=null&&!page.ToolsLoading);Application.DoEvents();
                var sheet=page.Viewport.Controls[0];
                Func<string,ToggleSwitch> toggle=name=>sheet.Controls.OfType<ToggleSwitch>().Concat(sheet.Controls.OfType<ToolRowActions>().Select(a=>a.Toggle)).First(t=>t.Text==name);
                check(page.ToolState!=null&&sheet.Controls.OfType<Label>().Any(l=>l.Text=="内置工具")&&sheet.Controls.OfType<Label>().Any(l=>l.Text=="自定义工具"),"the tools page lists built-in and custom tools from the backend");
                check(!toggle("Blender").Checked&&toggle("文件读写").Checked,"Blender starts off and the other built-in groups on");
                toggle("Blender").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("group blender True"));
                check(fake.Calls.Contains("group blender True"),"switching a built-in group saves it for this computer");
                Pump(()=>page.ToolState!=null&&!page.ToolsLoading);sheet=page.Viewport.Controls[0];
                toggle("MCP for Blender").AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(asked.Count==1&&asked[0].Contains("会运行 uvx")&&!fake.Calls.Contains("tool blender_mcp True")&&!toggle("MCP for Blender").Checked,"declining the first-use description leaves the tool off");
                answer=true;toggle("MCP for Blender").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("tool blender_mcp True"));
                check(asked.Count==2&&fake.Calls.Contains("tool blender_mcp True"),"confirming the description turns the tool on");
                Pump(()=>page.ToolState!=null&&!page.ToolsLoading);sheet=page.Viewport.Controls[0];
                check(!toggle("Broken").Enabled&&sheet.Controls.OfType<Label>().Any(l=>l.Text.Contains("schema must be 1")),"a tool with errors cannot be switched on and shows why");
                page.AskImport=()=>"{\"mcpServers\":{\"blender\":{\"command\":\"uvx\",\"args\":[\"mcp-for-blender\"]}}}";
                sheet.Controls.OfType<ModernButton>().First(b=>b.Text=="添加").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("import True"));
                check(fake.Calls.Contains("import False")&&fake.Calls.Contains("import True"),"pasted configuration is previewed, confirmed and then added");
                Pump(()=>page.ToolState!=null&&!page.ToolsLoading);sheet=page.Viewport.Controls[0];
                sheet.Controls.OfType<ModernButton>().First(b=>b.Text=="刷新").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("refresh"));
                check(fake.Calls.Contains("refresh"),"the refresh button asks every CMCP process to read the tools again");
                foreach(bool dark in new[]{true,false}){form.SetTheme(dark);Application.DoEvents();}
                check(!page.Viewport.NativeBarsVisible&&page.Viewport.Controls[0].Controls.OfType<ToolRowActions>().All(a=>a.Right<=page.Viewport.Controls[0].Width),"tool rows fit the page in both themes");
                L.Set("en");page.ShowTools();Application.DoEvents();check(page.Viewport.Controls[0].Controls.OfType<Label>().Any(l=>l.Text=="Built-in tools"),"the tools page is translated");L.Set("zh-CN");
            }
            using(var preview=new Manager(true)){
                preview.Show();Application.DoEvents();preview.OpenSettings();Application.DoEvents();preview.Settings.ShowTools();Application.DoEvents();
                check(preview.Settings.Viewport.Controls[0].Controls.OfType<Label>().Any(l=>l.Text=="预览模式"),"the preview window never starts the tool command");
            }
        }
    }
}
