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
        internal bool Enabled,Approved,Overridden,Global;
        internal string[] Errors=new string[0],Warnings=new string[0],MissingSecrets=new string[0],Tools,Recent=new string[0];
        internal string Describe{get{return L.Language=="en"?DescribeEn:DescribeZh;}}
        internal string Runtime{get{return L.Language=="en"?RuntimeEn:RuntimeZh;}}
    }
    internal sealed class ToolSnapshot {
        internal readonly Dictionary<string,bool> Groups=new Dictionary<string,bool>(),GlobalGroups=new Dictionary<string,bool>();
        internal readonly HashSet<string> OverriddenGroups=new HashSet<string>();internal string Device;
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
            var global=O(data,"globalGroups");foreach(var pair in global??groups??new Dictionary<string,object>())if(pair.Value is bool)snapshot.GlobalGroups[pair.Key]=(bool)pair.Value;
            foreach(var name in A(data,"overriddenGroups",Convert.ToString)??new string[0])snapshot.OverriddenGroups.Add(name);snapshot.Device=S(data,"device");
            var blender=O(data,"blender");snapshot.Blender=S(blender,"detected");snapshot.BlenderOfferDone=B(blender,"offerDone");
            object[] tools=null;object raw;if(data.TryGetValue("tools",out raw))tools=raw as object[];
            foreach(var item in tools??new object[0]){
                var t=item as IDictionary<string,object>;if(t==null)continue;var describe=O(t,"describe");var runtime=O(t,"runtime");
                snapshot.Tools.Add(new ToolInfo{Id=S(t,"id"),Name=S(t,"name")??S(t,"id"),Description=S(t,"description")??"",Version=S(t,"version"),Homepage=S(t,"homepage"),Log=S(t,"log"),
                    Enabled=B(t,"enabled"),Approved=B(t,"approved"),Overridden=B(t,"overridden"),Global=t.ContainsKey("global")?B(t,"global"):B(t,"enabled"),Errors=A(t,"errors",Convert.ToString)??new string[0],
                    Warnings=A(t,"warnings",w=>{var d=w as IDictionary<string,object>;return d==null?null:S(d,"code");})??new string[0],
                    MissingSecrets=A(t,"missingSecrets",Convert.ToString)??new string[0],Tools=A(t,"tools",Convert.ToString),Recent=A(t,"recent",Convert.ToString)??new string[0],
                    DescribeZh=S(describe,"zh"),DescribeEn=S(describe,"en"),RuntimeZh=S(runtime,"zh"),RuntimeEn=S(runtime,"en")});
            }
            return snapshot;
        }
    }
    internal interface IToolBackend {
        ToolSnapshot Status(string device);
        void SetGroup(string group,bool on);
        void SetTool(string id,bool on);
        // device null: the switches for this computer; a device: its overrides (null value = follow).
        void Apply(IDictionary<string,bool?> groups,IDictionary<string,bool?> tools,string device);
        void SetIdle(int minutes);
        void BlenderOfferDone();
        void Refresh();
        string Import(string text,bool apply);
        void Remove(string id);
    }
    // Runs app/mcp-tools-cli.mjs with the bundled node; pasted text goes through stdin only.
    internal sealed partial class CliToolBackend : IToolBackend {
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
        public ToolSnapshot Status(string device){return ToolSnapshot.Parse(String.IsNullOrEmpty(device)?Run(null,"status"):Run(null,"status","--device",device));}
        public void SetGroup(string group,bool on){Run(null,"set","--group",group,on?"--on":"--off");}
        public void SetTool(string id,bool on){Run(null,"set","--tool",id,on?"--on":"--off");}
        public void Apply(IDictionary<string,bool?> groups,IDictionary<string,bool?> tools,string device){Run(new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"groups",groups},{"tools",tools},{"device",String.IsNullOrEmpty(device)?null:device}}),"apply");}
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
        // Reads the tool state off the window thread. When the same tools are listed again, the rows
        // are updated in place (no rebuild, scroll and focus stay); only a changed list rebuilds.
        internal void LoadTools(){
            if(Tools==null)return;
            if(toolsLoading){reloadAgain=true;return;}
            toolsLoading=true;var backend=Tools;var scope=toolScope;
            ThreadPool.QueueUserWorkItem(delegate{
                ToolSnapshot snapshot;try{snapshot=backend.Status(scope);}catch(Exception e){snapshot=new ToolSnapshot{Error=e.Message};}
                try{BeginInvoke((Action)delegate{
                    toolsLoading=false;if(scope!=toolScope){LoadTools();return;}var previous=toolSnapshot;toolSnapshot=snapshot;
                    if(page==ToolsIndex){if(SameShape(previous,snapshot)){RefreshControls();}else RebuildKeepingScroll();}
                    if(reloadAgain){reloadAgain=false;LoadTools();}
                });}catch{toolsLoading=false;}
            });
        }
        static bool SameShape(ToolSnapshot a,ToolSnapshot b){
            if(a==null||b==null||a.Error!=null||b.Error!=null)return false;
            return a.Tools.Select(t=>t.Id).SequenceEqual(b.Tools.Select(t=>t.Id));
        }
        void RebuildKeepingScroll(){int y=-Viewport.AutoScrollPosition.Y;ToolRebuilds++;Build();Viewport.AutoScrollPosition=new Point(0,y);}
        internal int ToolRebuilds;
        internal ToolSnapshot ToolState{get{return toolSnapshot;}}
        internal bool ToolsLoading{get{return toolsLoading||(switches!=null&&switches.Busy);}}
        bool reloadAgain;
        ToolSwitchSaver switches;
        ToolSwitchSaver Switches{get{
            if(switches==null)switches=new ToolSwitchSaver(this,()=>Tools,()=>toolScope,error=>SetFeedback(L.Text("操作未完成：")+error,true),delegate{SetFeedback("已保存，正在通知已连接的 Claude。",false);LoadTools();});
            return switches;}}
        ToolInfo CurrentTool(string id){return toolSnapshot==null?null:toolSnapshot.Tools.FirstOrDefault(t=>t.Id==id);}
        bool GroupOn(string group){bool on;return toolSnapshot!=null&&toolSnapshot.Groups.TryGetValue(group,out on)&&on;}
        bool GlobalOn(string group){bool on;return toolSnapshot!=null&&toolSnapshot.GlobalGroups.TryGetValue(group,out on)&&on;}
        // Device cards (id, name) whose switches can differ from this computer's; set by the window.
        internal List<KeyValuePair<string,string>> Devices=new List<KeyValuePair<string,string>>();
        string toolScope;
        internal string ToolScope{get{return toolScope;}}
        internal void ChooseScope(string device){
            device=String.IsNullOrEmpty(device)?null:device;if(device==toolScope)return;
            if(switches!=null)switches.Drain();toolScope=device;toolSnapshot=null;int y=-Viewport.AutoScrollPosition.Y;Build();Viewport.AutoScrollPosition=new Point(0,y);
        }
        string FollowNote(bool overridden,bool global){return toolScope==null?"":"  ·  "+(overridden?String.Format(L.Text("这台设备单独设置（全局：{0}）"),L.Text(global?"开":"关")):L.Text("跟随全局"));}
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
            if(Devices.Count>0){
                var scopeSection=AddSection("适用范围");
                var choices=new List<KeyValuePair<string,string>>{new KeyValuePair<string,string>("",L.Text("所有设备"))};choices.AddRange(Devices);
                var scopeField=new DropdownField(choices.ToArray()){Font=sheet.Font,Size=new Size(216,36),Colors=colors};
                scopeField.Chosen+=key=>ChooseScope(key);
                refresh.Add(delegate{scopeField.Value=toolScope??"";scopeField.AccessibleName=L.Text("适用范围");scopeField.Invalidate();});
                AddRow(scopeSection,"适用范围","“所有设备”是这台电脑的开关。选择一台设备后，开关只改这台设备，其余设备不受影响。",scopeField);
            }
            var builtin=AddSection("内置工具");
            foreach(var row in GroupRows){
                string group=row[0];
                var actions=new ToolRowActions();
                actions.Toggle=new ToggleSwitch{Text=L.Text(row[1]),Checked=GroupOn(group),Colors=colors,Size=new Size(48,30)};
                var toggle=actions.Toggle;
                // Only this switch changes now; quick clicks are merged and saved once, as the last state.
                toggle.Click+=delegate{Switches.Want(true,group,toggle.Checked);if(toolScope!=null){toolSnapshot.OverriddenGroups.Add(group);actions.ShowFollow(true);}};
                if(toolScope!=null)actions.Follow=Command("跟随全局",delegate{Switches.Want(true,group,null);toolSnapshot.OverriddenGroups.Remove(group);toolSnapshot.Groups[group]=GlobalOn(group);toggle.Checked=GlobalOn(group);actions.ShowFollow(false);RefreshControls();});
                refresh.Add(delegate{if(!Switches.Pending(true,group)){toggle.Checked=GroupOn(group);actions.ShowFollow(toolSnapshot.OverriddenGroups.Contains(group));}});
                actions.Arrange();
                AddRow(builtin,()=>L.Text(row[1]),()=>(group=="blender"?L.Text(row[2])+" "+(toolSnapshot.Blender!=null?L.Text("已检测到 Blender：")+toolSnapshot.Blender:L.Text("没有检测到本机安装的 Blender。")):L.Text(row[2]))+FollowNote(toolSnapshot.OverriddenGroups.Contains(group),GlobalOn(group)),actions);
            }
            var custom=AddSection("自定义工具");
            if(toolSnapshot.Tools.Count==0)AddRow(custom,"还没有自定义工具","粘贴 GitHub 上 MCP 服务器给出的配置即可添加；也可以照 mcp-tools 文件夹里的 AGENT.md 自己编写。",null);
            foreach(var tool in toolSnapshot.Tools){
                string id=tool.Id;
                var actions=new ToolRowActions();
                actions.Log=Command("日志",delegate{var item=CurrentTool(id);if(item!=null&&File.Exists(item.Log))OpenPath(item.Log);else SetFeedback("这个工具还没有日志。",false);});
                if(toolScope!=null)actions.Follow=Command("跟随全局",delegate{var item=CurrentTool(id);if(item==null)return;Switches.Want(false,id,null);item.Overridden=false;item.Enabled=item.Global;actions.Toggle.Checked=item.Global&&item.Approved;actions.ShowFollow(false);RefreshControls();});
                else actions.Remove=Danger("删除",delegate{
                    var item=CurrentTool(id);if(item==null)return;
                    if(!ConfirmTool(String.Format(L.Text("删除 {0}？\r\n\r\n文件夹会移到 mcp-tools 里以 .removed- 开头的文件夹，可以手动恢复。"),item.Name)))return;
                    ToolAction(()=>Tools.Remove(id),"已删除，正在通知已连接的 Claude。");});
                actions.Toggle=new ToggleSwitch{Text=tool.Name,Checked=tool.Enabled&&tool.Approved,Colors=colors,Size=new Size(48,30),Enabled=tool.Errors.Length==0};
                var toggle=actions.Toggle;
                toggle.Click+=delegate{
                    var item=CurrentTool(id);if(item==null)return;bool next=toggle.Checked;
                    if(next&&!item.Approved){
                        if(!ConfirmTool(item.Describe+"\r\n\r\n"+L.Text("开启这个工具吗？"))){toggle.Checked=false;return;}
                        item.Approved=true;
                    }
                    Switches.Want(false,id,next);if(toolScope!=null){item.Overridden=true;actions.ShowFollow(true);}};
                refresh.Add(delegate{var item=CurrentTool(id);if(item==null)return;toggle.Enabled=item.Errors.Length==0;if(!Switches.Pending(false,id)){toggle.Checked=item.Enabled&&item.Approved;actions.ShowFollow(item.Overridden);}});
                actions.Arrange();
                AddRow(custom,()=>{var item=CurrentTool(id);return item==null?"":item.Name+(item.Version!=null?" "+item.Version:"");},()=>{var item=CurrentTool(id);return item==null?"":ToolDetail(item)+FollowNote(item.Overridden,item.Global);},actions);
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
    // Collects quick switch clicks and saves only the last state of each switch, one save at a time.
    internal sealed class ToolSwitchSaver : IDisposable {
        readonly Dictionary<string,bool?> groups=new Dictionary<string,bool?>(),tools=new Dictionary<string,bool?>();
        Dictionary<string,bool?> sendingGroups=new Dictionary<string,bool?>(),sendingTools=new Dictionary<string,bool?>();
        readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer{Interval=350};
        readonly Control owner;readonly Func<IToolBackend> backend;readonly Func<string> device;readonly Action<string> failed;readonly Action saved;
        internal volatile bool Busy;internal int Saves;
        internal ToolSwitchSaver(Control owner,Func<IToolBackend> backend,Func<string> device,Action<string> failed,Action saved){this.owner=owner;this.backend=backend;this.device=device;this.failed=failed;this.saved=saved;timer.Tick+=delegate{Flush();};}
        internal bool Pending(bool group,string id){return group?groups.ContainsKey(id)||sendingGroups.ContainsKey(id):tools.ContainsKey(id)||sendingTools.ContainsKey(id);}
        // on null: this device follows the computer's switch again.
        internal void Want(bool group,string id,bool? on){(group?groups:tools)[id]=on;timer.Stop();timer.Start();}
        internal void Flush(){
            timer.Stop();
            if(Busy||groups.Count+tools.Count==0)return;
            var target=backend();if(target==null)return;
            sendingGroups=new Dictionary<string,bool?>(groups);sendingTools=new Dictionary<string,bool?>(tools);groups.Clear();tools.Clear();Busy=true;Saves++;
            var g=sendingGroups;var t=sendingTools;var d=device();
            ThreadPool.QueueUserWorkItem(delegate{
                string error=null;try{target.Apply(g,t,d);}catch(Exception e){error=e.Message;}
                Busy=false;
                try{owner.BeginInvoke((Action)delegate{
                    sendingGroups=new Dictionary<string,bool?>();sendingTools=new Dictionary<string,bool?>();
                    if(error!=null)failed(error);
                    if(groups.Count+tools.Count>0)Flush();else saved();
                });}catch{}
            });
        }
        // The page is closing or the scope changes: what is still waiting is saved after the save in flight.
        internal void Drain(){
            timer.Stop();
            if(groups.Count+tools.Count==0)return;
            var target=backend();if(target==null)return;
            var g=new Dictionary<string,bool?>(groups);var t=new Dictionary<string,bool?>(tools);var d=device();groups.Clear();tools.Clear();Saves++;
            ThreadPool.QueueUserWorkItem(delegate{var clock=Stopwatch.StartNew();while(Busy&&clock.ElapsedMilliseconds<30000)Thread.Sleep(20);try{target.Apply(g,t,d);}catch{}});
        }
        public void Dispose(){timer.Dispose();}
    }
    // Log and delete buttons beside a tool's switch, laid out as one row control.
    internal sealed class ToolRowActions : Panel {
        internal ModernButton Log,Remove,Follow;internal ToggleSwitch Toggle;
        // Buttons left of the switch; the width stays fixed, so a Follow button that comes and
        // goes never moves the row's text.
        internal void Arrange(){
            var buttons=new[]{Log,Remove,Follow}.Where(b=>b!=null).ToList();
            Controls.AddRange(buttons.Cast<Control>().Concat(new Control[]{Toggle}).ToArray());
            foreach(var b in buttons)b.Size=new Size(Math.Max(64,TextRenderer.MeasureText(L.Text(b.Text),b.Font).Width+28),34);
            int x=0;foreach(var b in buttons){b.Location=new Point(x,2);x=b.Right+8;}
            Toggle.Location=new Point(x+4,4);Size=new Size(Toggle.Right,38);
        }
        internal void ShowFollow(bool shown){if(Follow!=null&&Follow.Visible!=shown)Follow.Visible=shown;}
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
                ToolSnapshot snapshot;try{snapshot=backend.Status(null);}catch{return;}
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
        internal readonly Dictionary<string,Dictionary<string,bool>> GroupOverrides=new Dictionary<string,Dictionary<string,bool>>(),ToolOverrides=new Dictionary<string,Dictionary<string,bool>>();
        // A new copy each time, as the command line returns; a device sees its overrides.
        public ToolSnapshot Status(string device){Calls.Add("status"+(device==null?"":"@"+device));lock(State){
            var copy=new ToolSnapshot{Root=State.Root,Blender=State.Blender,BlenderOfferDone=State.BlenderOfferDone,IdleMinutes=State.IdleMinutes,Device=device};
            Dictionary<string,bool> groups=null,tools=null;if(device!=null){GroupOverrides.TryGetValue(device,out groups);ToolOverrides.TryGetValue(device,out tools);}
            foreach(var g in State.Groups){bool own;bool has=groups!=null&&groups.TryGetValue(g.Key,out own);copy.GlobalGroups[g.Key]=g.Value;copy.Groups[g.Key]=has?groups[g.Key]:g.Value;if(has)copy.OverriddenGroups.Add(g.Key);}
            foreach(var t in State.Tools){bool has=tools!=null&&tools.ContainsKey(t.Id);
                copy.Tools.Add(new ToolInfo{Id=t.Id,Name=t.Name,Description=t.Description,Version=t.Version,Log=t.Log,DescribeZh=t.DescribeZh,DescribeEn=t.DescribeEn,Enabled=has?tools[t.Id]:t.Enabled,Global=t.Enabled,Overridden=has,Approved=t.Approved,Errors=t.Errors,Warnings=t.Warnings,MissingSecrets=t.MissingSecrets,Tools=t.Tools});}
            return copy;}}
        public void SetGroup(string group,bool on){Calls.Add("group "+group+" "+on);State.Groups[group]=on;}
        public void SetTool(string id,bool on){Calls.Add("tool "+id+" "+on);var t=State.Tools.First(x=>x.Id==id);t.Enabled=on;if(on)t.Approved=true;}
        internal int Delay;
        public void Apply(IDictionary<string,bool?> groups,IDictionary<string,bool?> tools,string device){
            Calls.Add("apply"+(device==null?"":"@"+device)+" "+String.Join(",",groups.Select(p=>p.Key+"="+(p.Value.HasValue?p.Value.ToString():"null")).Concat(tools.Select(p=>p.Key+"="+(p.Value.HasValue?p.Value.ToString():"null")))));
            if(Delay>0)Thread.Sleep(Delay);
            lock(State){
                if(device==null){foreach(var p in groups)State.Groups[p.Key]=p.Value.Value;foreach(var p in tools){var t=State.Tools.First(x=>x.Id==p.Key);t.Enabled=p.Value.Value;if(p.Value.Value)t.Approved=true;}return;}
                if(!GroupOverrides.ContainsKey(device))GroupOverrides[device]=new Dictionary<string,bool>();if(!ToolOverrides.ContainsKey(device))ToolOverrides[device]=new Dictionary<string,bool>();
                foreach(var p in groups){if(p.Value.HasValue)GroupOverrides[device][p.Key]=p.Value.Value;else GroupOverrides[device].Remove(p.Key);}
                foreach(var p in tools){if(p.Value.HasValue){ToolOverrides[device][p.Key]=p.Value.Value;if(p.Value.Value)State.Tools.First(x=>x.Id==p.Key).Approved=true;}else ToolOverrides[device].Remove(p.Key);}
            }
        }
        public void SetIdle(int minutes){Calls.Add("idle "+minutes);State.IdleMinutes=minutes;}
        public void BlenderOfferDone(){Calls.Add("offer");State.BlenderOfferDone=true;}
        public void Refresh(){Calls.Add("refresh");}
        public string Import(string text,bool apply){Calls.Add("import "+apply);if(apply)lock(State)State.Tools.Add(new ToolInfo{Id="added",Name="Added",Description="new",DescribeZh="新",DescribeEn="new"});return "{\"items\":[{\"id\":\"blender_mcp\",\"describe\":{\"zh\":\"运行 uvx\",\"en\":\"runs uvx\"},\"errors\":[],\"warnings\":[]}]}";}
        public void Remove(string id){Calls.Add("remove "+id);State.Tools.RemoveAll(t=>t.Id==id);}
    }
    internal static class ToolsPageTests {
        static void Pump(Func<bool> done){var clock=Stopwatch.StartNew();while(!done()&&clock.ElapsedMilliseconds<5000){Application.DoEvents();Thread.Sleep(5);}}
        internal static void Run(string directory,Action<bool,string> check){
            var parsed=ToolSnapshot.Parse("{\"root\":\"F:\\\\CMCP\\\\mcp-tools\",\"groups\":{\"files\":true,\"blender\":false},\"idleMinutes\":0,\"blender\":{\"detected\":\"C:\\\\Blender\\\\blender.exe\",\"offerDone\":false},\"tools\":[{\"id\":\"gh\",\"name\":\"GitHub\",\"enabled\":true,\"approved\":true,\"errors\":[],\"warnings\":[{\"code\":\"UNPINNED\"}],\"missingSecrets\":[\"env:TOKEN\"],\"tools\":[\"gh__a\",\"gh__b\"],\"describe\":{\"zh\":\"中\",\"en\":\"en\"},\"runtime\":null}]}");
            check(parsed.Groups["files"]&&!parsed.Groups["blender"]&&parsed.IdleMinutes==0&&parsed.Blender==@"C:\Blender\blender.exe"&&parsed.Tools[0].Tools.Length==2&&parsed.Tools[0].Warnings.Contains("UNPINNED")&&parsed.Tools[0].MissingSecrets[0]=="env:TOKEN","tool status from the command line parses groups, tools, secrets and warnings");
            check(ToolSnapshot.Parse("{\"error\":\"broken\"}").Error=="broken","a tool command error is reported, not thrown");
            using(var form=new Manager(true)){
                form.ClientSize=new Size(760,460);form.Show();Application.DoEvents();form.OpenSettings();Application.DoEvents();
                var fake=new FakeToolBackend();fake.State.Tools.Add(new ToolInfo{Id="blender_mcp",Name="MCP for Blender",Description="Blender",DescribeZh="会运行 uvx",DescribeEn="runs uvx"});
                fake.State.Tools.Add(new ToolInfo{Id="broken",Name="Broken",Description="x",Errors=new[]{"schema must be 1"}});
                var page=form.Settings;page.Tools=fake;var asked=new List<string>();bool answer=false;page.ConfirmTool=text=>{asked.Add(text);return answer;};
                Func<bool> idle=()=>page.ToolState!=null&&!page.ToolsLoading;
                Action settle=()=>{var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<5000){Application.DoEvents();Thread.Sleep(10);if(idle()&&clock.ElapsedMilliseconds>700)break;}};
                page.ShowTools();Pump(idle);Application.DoEvents();
                var sheet=page.Viewport.Controls[0];
                Func<string,ToggleSwitch> toggle=name=>sheet.Controls.OfType<ToggleSwitch>().Concat(sheet.Controls.OfType<ToolRowActions>().Select(a=>a.Toggle)).First(t=>t.Text==name);
                Func<int> applies=()=>fake.Calls.Count(c=>c.StartsWith("apply "));
                check(page.ToolState!=null&&sheet.Controls.OfType<Label>().Any(l=>l.Text=="内置工具")&&sheet.Controls.OfType<Label>().Any(l=>l.Text=="自定义工具"),"the tools page lists built-in and custom tools from the backend");
                var blender=toggle("Blender");
                check(!blender.Checked&&toggle("文件读写").Checked,"Blender starts off and the other built-in groups on");
                page.Viewport.AutoScrollPosition=new Point(0,120);Application.DoEvents();int scrolled=-page.Viewport.AutoScrollPosition.Y,rebuilds=page.ToolRebuilds;
                blender.Focus();
                for(int i=0;i<7;i++){blender.AccessibilityObject.DoDefaultAction();Application.DoEvents();}
                check(blender.Checked&&applies()==0,"quick clicks change only the switch at once and wait before saving");
                settle();
                check(applies()==1&&fake.State.Groups["blender"]&&fake.Calls.Last(c=>c.StartsWith("apply ")).Contains("blender=True"),"seven quick clicks become one save of the last state ("+String.Join(" | ",fake.Calls.Where(c=>c.StartsWith("apply ")))+")");
                check(page.ToolRebuilds==rebuilds&&!blender.IsDisposed&&Object.ReferenceEquals(blender,toggle("Blender"))&&blender.Checked,"saving switches updates the rows in place without rebuilding the page");
                check(-page.Viewport.AutoScrollPosition.Y==scrolled&&scrolled>0&&blender.Focused,"switching keeps the scroll position ("+scrolled+") and keyboard focus");
                fake.Delay=600;int before=applies();
                for(int i=0;i<3;i++){blender.AccessibilityObject.DoDefaultAction();Application.DoEvents();}
                var wait=Stopwatch.StartNew();while(wait.ElapsedMilliseconds<550){Application.DoEvents();Thread.Sleep(10);}
                for(int i=0;i<2;i++){blender.AccessibilityObject.DoDefaultAction();Application.DoEvents();}
                settle();settle();fake.Delay=0;
                check(applies()-before<=2&&fake.State.Groups["blender"]==blender.Checked&&blender.Checked==false&&page.ToolRebuilds==rebuilds,"clicks during a save are saved after it, ending in the last state without a rebuild ("+(applies()-before)+" saves)");
                toggle("MCP for Blender").AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(asked.Count==1&&asked[0].Contains("会运行 uvx")&&!toggle("MCP for Blender").Checked,"declining the first-use description leaves the tool off");
                answer=true;toggle("MCP for Blender").AccessibilityObject.DoDefaultAction();settle();
                check(asked.Count==2&&fake.Calls.Any(c=>c.StartsWith("apply ")&&c.Contains("blender_mcp=True"))&&toggle("MCP for Blender").Checked,"confirming the description turns the tool on");
                for(int i=0;i<4;i++){toggle("MCP for Blender").AccessibilityObject.DoDefaultAction();Application.DoEvents();}settle();
                check(asked.Count==2&&fake.State.Tools.First(t=>t.Id=="blender_mcp").Enabled&&page.ToolRebuilds==rebuilds,"an approved tool switches quickly without asking again");
                check(!toggle("Broken").Enabled&&sheet.Controls.OfType<Label>().Any(l=>l.Text.Contains("schema must be 1")),"a tool with errors cannot be switched on and shows why");
                page.AskImport=()=>"{\"mcpServers\":{\"blender\":{\"command\":\"uvx\",\"args\":[\"mcp-for-blender\"]}}}";
                page.Viewport.AutoScrollPosition=new Point(0,80);Application.DoEvents();scrolled=-page.Viewport.AutoScrollPosition.Y;
                sheet.Controls.OfType<ModernButton>().First(b=>b.Text=="添加").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("import True"));settle();
                sheet=page.Viewport.Controls[0];
                check(fake.Calls.Contains("import False")&&fake.Calls.Contains("import True")&&sheet.Controls.OfType<ToolRowActions>().Any(a=>a.Toggle.Text=="Added"),"pasted configuration is previewed, confirmed and then added");
                check(page.ToolRebuilds==rebuilds+1&&Math.Abs(-page.Viewport.AutoScrollPosition.Y-scrolled)<=1,"a changed tool list rebuilds once and keeps the scroll position");
                sheet.Controls.OfType<ModernButton>().First(b=>b.Text=="刷新").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("refresh"));
                check(fake.Calls.Contains("refresh"),"the refresh button asks every CMCP process to read the tools again");
                blender=toggle("Blender");blender.AccessibilityObject.DoDefaultAction();Application.DoEvents();before=applies();
                form.CloseSettings();var drain=Stopwatch.StartNew();while(applies()==before&&drain.ElapsedMilliseconds<3000){Application.DoEvents();Thread.Sleep(10);}
                check(applies()==before+1&&fake.State.Groups["blender"],"a click right before leaving the page is still saved");
                form.OpenSettings();Application.DoEvents();page=form.Settings;page.Tools=fake;page.ShowTools();Pump(idle);Application.DoEvents();
                foreach(bool dark in new[]{true,false}){form.SetTheme(dark);Application.DoEvents();}
                check(!page.Viewport.NativeBarsVisible&&page.Viewport.Controls[0].Controls.OfType<ToolRowActions>().All(a=>a.Right<=page.Viewport.Controls[0].Width),"tool rows fit the page in both themes");
                L.Set("en");page.ShowTools();Application.DoEvents();check(page.Viewport.Controls[0].Controls.OfType<Label>().Any(l=>l.Text=="Built-in tools"),"the tools page is translated");L.Set("zh-CN");
                // One device's own switches on top of this computer's.
                page.Devices=new List<KeyValuePair<string,string>>{new KeyValuePair<string,string>("work-vps","工作 VPS")};page.ShowTools();Pump(idle);Application.DoEvents();sheet=page.Viewport.Controls[0];
                var scopeField=sheet.Controls.OfType<DropdownField>().FirstOrDefault(d=>d.AccessibleName=="适用范围");
                check(scopeField!=null&&scopeField.Value=="","the scope list offers this computer and every device card");
                scopeField.Choose("work-vps");Pump(()=>page.ToolScope=="work-vps"&&page.ToolState!=null&&!page.ToolsLoading);Application.DoEvents();sheet=page.Viewport.Controls[0];
                bool globalBlender=fake.State.Groups["blender"];var deviceBlender=toggle("Blender");var row=sheet.Controls.OfType<ToolRowActions>().First(a=>a.Toggle==deviceBlender);
                check(fake.Calls.Contains("status@work-vps")&&deviceBlender.Checked==globalBlender&&(row.Follow==null||!row.Follow.Visible),"a device first follows this computer's switches");
                deviceBlender.AccessibilityObject.DoDefaultAction();settle();
                check(fake.Calls.Any(c=>c=="apply@work-vps blender="+(!globalBlender))&&fake.State.Groups["blender"]==globalBlender&&deviceBlender.Checked==!globalBlender&&row.Follow.Visible,"switching in a device's scope changes only that device and offers Follow global");
                row.Follow.AccessibilityObject.DoDefaultAction();settle();
                check(fake.Calls.Any(c=>c=="apply@work-vps blender=null")&&!fake.GroupOverrides["work-vps"].ContainsKey("blender")&&deviceBlender.Checked==globalBlender&&!row.Follow.Visible,"Follow global removes the device's own setting");
                page.ChooseScope(null);Pump(idle);
            }
            using(var preview=new Manager(true)){
                preview.Show();Application.DoEvents();preview.OpenSettings();Application.DoEvents();preview.Settings.ShowTools();Application.DoEvents();
                check(preview.Settings.Viewport.Controls[0].Controls.OfType<Label>().Any(l=>l.Text=="预览模式"),"the preview window never starts the tool command");
            }
        }
    }
}
