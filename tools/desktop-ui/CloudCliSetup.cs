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
    // What the backend or the setup action found each device's CloudCLI to be (app/cloudcli.mjs).
    internal static class CloudCliKinds {
        internal const string SelfHosted="self-hosted",WebDesktop="webdesktop";
        internal static Dictionary<string,string> Load(string directory){
            var kinds=new Dictionary<string,string>(StringComparer.Ordinal);
            try{
                string file=Path.Combine(directory,"cloudcli-kinds.json");
                if(!File.Exists(file)||new FileInfo(file).Length>256*1024)return kinds;
                var data=LocalState.Obj(LocalState.Read(file));
                if(Convert.ToString(LocalState.Get(data,"schema"))!="1")return kinds;
                var values=LocalState.Obj(LocalState.Get(data,"kinds"));if(values==null)return kinds;
                foreach(var pair in values){string kind=pair.Value as string;if(pair.Key.Length<=480&&(kind==SelfHosted||kind==WebDesktop))kinds[pair.Key]=kind;}
            }catch{}
            return kinds;
        }
    }
    // The device's background SSH channel without a terminal window, the way a terminal starts it:
    // app/ssh-terminal.mjs waits until the worker is ready and leaves it running for this window.
    internal static class SshChannel {
        internal static ProcessStartInfo Info(string kit,string directory,SshLogin login,int owner,string ssh,string program){
            var start=new ProcessStartInfo(Path.Combine(kit,"runtime","node.exe")){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=kit,RedirectStandardOutput=true,RedirectStandardError=true};
            start.Arguments=String.Join(" ",new[]{Path.Combine(kit,"ssh-terminal.mjs"),"--state",directory,"--id",login.name,"--owner",owner.ToString(),"--ssh",ssh??"ssh"}.Select(Quote));
            Environment(start,directory,login,program);return start;
        }
        // ssh asks CMCP.exe for anything it needs; a saved secret only answers its own prompt.
        internal static void Environment(ProcessStartInfo start,string directory,SshLogin login,string program){
            start.EnvironmentVariables["CMCP_STATE_DIR"]=directory;start.EnvironmentVariables["SSH_ASKPASS"]=program;
            start.EnvironmentVariables["SSH_ASKPASS_REQUIRE"]="force";start.EnvironmentVariables[SshAskpass.Variable]=login.name;start.EnvironmentVariables["DISPLAY"]="cmcp";
        }
        internal static string Quote(string value){
            if(value.Length>0&&value.IndexOfAny(new[]{' ','\t','"'})<0)return value;
            var text=new StringBuilder("\"");int slashes=0;
            foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){text.Append('\\',slashes*2+1);slashes=0;text.Append(c);continue;}text.Append('\\',slashes);slashes=0;text.Append(c);}
            text.Append('\\',slashes*2);return text.Append('"').ToString();
        }
        internal static bool Start(string kit,string directory,SshLogin login,int owner){
            try{
                if(!File.Exists(Path.Combine(kit,"runtime","node.exe")))return false;
                var process=Process.Start(Info(kit,directory,login,owner,SshCommand.FindSsh(),Program.ExecutablePath));
                // Nobody reads its lines; draining them keeps the pipe from filling while it waits.
                process.OutputDataReceived+=delegate{};process.ErrorDataReceived+=delegate{};process.BeginOutputReadLine();process.BeginErrorReadLine();
                process.EnableRaisingEvents=true;process.Exited+=delegate{process.Dispose();};
                return true;
            }catch{return false;}
        }
    }
    // One run of app/cloudcli-setup.mjs. Its events arrive on this window's thread; the answer to the
    // plan goes to its stdin, so a sudo password never appears in arguments or the environment.
    internal sealed class CloudCliSetupRun {
        readonly Process process;readonly Control owner;
        internal event Action<IDictionary<string,object>> Event;
        internal static ProcessStartInfo Info(string kit,string directory,SshLogin login,int owner,string ssh,string program,string url){
            var start=new ProcessStartInfo(Path.Combine(kit,"runtime","node.exe")){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=kit,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8};
            var args=new List<string>{Path.Combine(kit,"cloudcli-setup.mjs"),"--state",directory,"--id",login.name,"--owner",owner.ToString(),"--ssh",ssh??"ssh"};
            if(!String.IsNullOrEmpty(url)){args.Add("--url");args.Add(url);}
            start.Arguments=String.Join(" ",args.Select(SshChannel.Quote));SshChannel.Environment(start,directory,login,program);return start;
        }
        internal CloudCliSetupRun(Control owner,ProcessStartInfo info){
            this.owner=owner;process=Process.Start(info);
            process.ErrorDataReceived+=delegate{};process.BeginErrorReadLine();
            var reader=new Thread(()=>{
                try{for(string line=process.StandardOutput.ReadLine();line!=null;line=process.StandardOutput.ReadLine()){
                    IDictionary<string,object> data=null;try{data=new JavaScriptSerializer().DeserializeObject(line) as IDictionary<string,object>;}catch{}
                    if(data!=null)Post(data);
                }}catch{}
                Post(null);
            }){IsBackground=true};reader.Start();
        }
        void Post(IDictionary<string,object> data){try{owner.BeginInvoke(new Action(()=>{if(Event!=null)Event(data);}));}catch(InvalidOperationException){}}
        internal void Answer(bool ok,string password){
            var value=new Dictionary<string,object>{{"ok",ok}};if(password!=null)value["password"]=password;
            var bytes=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value)+"\n");
            try{process.StandardInput.BaseStream.Write(bytes,0,bytes.Length);process.StandardInput.BaseStream.Flush();}catch(IOException){}catch(InvalidOperationException){}
            finally{Array.Clear(bytes,0,bytes.Length);}
        }
        internal void Cancel(){try{if(!process.HasExited)process.Kill();}catch{}}
    }
    // The single question of a setup run: what was found, what would change, and the sudo password
    // when one is needed. The password box is hidden text and is cleared as soon as it is read.
    internal sealed class CloudCliSetupDialog : Form {
        internal readonly TextBox Password=new TextBox{UseSystemPasswordChar=true,MaxLength=1024};
        internal readonly Button Confirm=new Button(),Cancel=new Button();
        internal readonly Label Body=new Label{AutoSize=false};
        internal CloudCliSetupDialog(IEnumerable<string> summary,IEnumerable<string> steps,bool needsPassword){
            var colors=Palette.Create(AppSettings.SystemDark(false,false));
            Text=L.Text("初始化／修复 CloudCLI 连接");FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=MinimizeBox=false;StartPosition=FormStartPosition.CenterParent;ShowInTaskbar=false;
            Font=new Font("Microsoft YaHei UI",10F);BackColor=colors.Surface;ForeColor=colors.Text;AutoScaleMode=AutoScaleMode.Dpi;
            var text=new StringBuilder(L.Text("检查结果")+"\r\n");foreach(var line in summary)text.Append("  · "+line+"\r\n");
            var changes=steps.ToList();
            text.Append("\r\n"+L.Text(changes.Count>0?"将要进行以下修改，确认后只执行一次：":"无需修改，确认后启动本机工具通道并核对结果。")+"\r\n");foreach(var line in changes)text.Append("  · "+line+"\r\n");
            Body.Text=text.ToString();Body.BackColor=colors.Surface;Body.ForeColor=colors.Text;
            int width=600,height=Math.Min(460,TextRenderer.MeasureText(Body.Text,Font,new Size(width-36,2000),TextFormatFlags.WordBreak).Height+12);
            Body.Bounds=new Rectangle(18,14,width-36,height);int y=Body.Bottom+8;
            var hint=new Label{Text=L.Text("sudo 密码（只用于这一次，不会保存）"),Bounds=new Rectangle(18,y,width-36,22),Visible=needsPassword,BackColor=colors.Surface,ForeColor=colors.Muted};
            Password.Bounds=new Rectangle(18,y+24,width-36,28);Password.Visible=needsPassword;Password.AccessibleName=L.Text("sudo 密码");if(needsPassword)y+=60;
            Confirm.Text=L.Text(changes.Count>0?"确认修改":"继续");Confirm.Bounds=new Rectangle(width-248,y+6,118,34);Confirm.DialogResult=DialogResult.OK;Confirm.UseVisualStyleBackColor=true;Confirm.ForeColor=SystemColors.ControlText;
            Cancel.Text=L.Text("取消");Cancel.Bounds=new Rectangle(width-122,y+6,104,34);Cancel.DialogResult=DialogResult.Cancel;Cancel.UseVisualStyleBackColor=true;Cancel.ForeColor=SystemColors.ControlText;
            ClientSize=new Size(width,y+54);Controls.AddRange(new Control[]{Body,hint,Password,Confirm,Cancel});AcceptButton=Confirm;CancelButton=Cancel;
            Shown+=delegate{if(needsPassword)Password.Focus();else Confirm.Focus();};
        }
        // Reads and clears the box, so the text does not stay in the control.
        internal string TakePassword(){if(!Password.Visible)return null;string value=Password.Text;Password.Clear();return value;}
    }
    internal static class CloudCliSetupTests {
        internal static void Run(string root,Action<bool,string> check){
            string directory=Path.Combine(root,"cloudcli-setup");Directory.CreateDirectory(directory);
            check(CloudCliKinds.Load(directory).Count==0,"no CloudCLI kind is known before the backend probes");
            File.WriteAllText(Path.Combine(directory,"cloudcli-kinds.json"),"{\"schema\":1,\"kinds\":{\"a\":\"self-hosted\",\"b\":\"webdesktop\",\"c\":\"other\"}}");
            var kinds=CloudCliKinds.Load(directory);check(kinds.Count==2&&kinds["a"]==CloudCliKinds.SelfHosted&&kinds["b"]==CloudCliKinds.WebDesktop,"CloudCLI kinds are read as the backend records them and unknown values are ignored");
            File.WriteAllText(Path.Combine(directory,"cloudcli-kinds.json"),"{broken");check(CloudCliKinds.Load(directory).Count==0,"an unreadable kind record counts as unknown");
            var login=new SshLogin{name="device",host="203.0.113.5",username="root",secret="TESTONLY-CIPHER"};
            var channel=SshChannel.Info(@"C:\CMCP app",@"C:\state dir",login,42,@"C:\Windows\System32\OpenSSH\ssh.exe",@"C:\CMCP app\CMCP.exe");
            check(channel.Arguments.Contains("ssh-terminal.mjs")&&channel.Arguments.Contains("--owner 42")&&channel.Arguments.Contains("\"C:\\state dir\"")&&channel.CreateNoWindow&&!channel.Arguments.Contains("TESTONLY")&&channel.EnvironmentVariables[SshAskpass.Variable]=="device"&&channel.EnvironmentVariables["SSH_ASKPASS_REQUIRE"]=="force","the automatic SSH channel starts hidden, like a terminal's, with no secret on its command line");
            var setup=CloudCliSetupRun.Info(@"C:\CMCP app",@"C:\state dir",login,42,"ssh.exe",@"C:\CMCP.exe","https://cli.example.com");
            check(setup.Arguments.Contains("cloudcli-setup.mjs")&&setup.Arguments.Contains("--url https://cli.example.com")&&setup.RedirectStandardInput&&!setup.EnvironmentVariables.ContainsKey("SUDO_PASSWORD")&&!setup.Arguments.Contains("TESTONLY"),"the setup run gets its answers on stdin and no secret in arguments or environment");
            check(SshChannel.Quote("a\"b\\")=="\"a\\\"b\\\\\""&&SshChannel.Quote("plain")=="plain","process arguments are quoted the way Windows splits them");
            check(SshLogin.ValidAccount("")&&SshLogin.ValidAccount("ubuntu")&&!SshLogin.ValidAccount("root")&&!SshLogin.ValidAccount("a;b")&&!SshLogin.ValidAccount("Ubuntu"),"only plain Linux account names can be saved for the SSH hand-over");
            var store=new SshStore();store.Put(new SshLogin{name="device",host="203.0.113.5",username="root",cloudcliUser="ubuntu",sshAutoStart=true});store.Save(directory);
            var restored=SshStore.Load(directory).Get("device");check(restored!=null&&restored.cloudcliUser=="ubuntu"&&restored.sshAutoStart==true,"the CloudCLI account and the automatic channel switch survive a save");
            File.WriteAllText(SshStore.PathFor(directory),File.ReadAllText(SshStore.PathFor(directory)).Replace("\"ubuntu\"","\"a;b\""));check(SshStore.Load(directory).ReadError,"a damaged CloudCLI account is refused, not used");
            using(var dialog=new CloudCliSetupDialog(new[]{"系统：Ubuntu 24.04 LTS"},new[]{"为 ubuntu 安装 Claude CLI"},true)){
                dialog.Show();Application.DoEvents();dialog.Password.Text="SUDO-FIXTURE";
                check(dialog.Password.UseSystemPasswordChar&&dialog.Body.Text.Contains("Ubuntu 24.04")&&dialog.Body.Text.Contains("安装 Claude CLI")&&dialog.Confirm.Bottom<=dialog.ClientSize.Height,"the setup question lists what was found and what would change, with a hidden password box");
                check(dialog.TakePassword()=="SUDO-FIXTURE"&&dialog.Password.Text.Length==0,"the sudo password leaves the box as soon as it is read");
            }
            using(var dialog=new CloudCliSetupDialog(new[]{"系统：Debian GNU/Linux 12"},new string[0],false)){dialog.Show();Application.DoEvents();check(!dialog.Password.Visible&&dialog.TakePassword()==null&&dialog.Confirm.Text==L.Text("继续"),"a run with nothing to change asks no password");}
            Window(Path.Combine(root,"cloudcli-window"),check);
        }
        static void Pump(){var until=DateTime.UtcNow.AddMilliseconds(320);while(DateTime.UtcNow<until){Application.DoEvents();Thread.Sleep(10);}}
        // Real state files and a real window; only starting processes is replaced.
        static void Window(string state,Action<bool,string> check){
            string kit=Path.Combine(state,"kit");Directory.CreateDirectory(kit);
            var cloud=new CloudCliStore();cloud.Put(new CloudCliLogin{name="self",url="https://cli.example.com"});cloud.Put(new CloudCliLogin{name="desk",url="https://desk-claude.example.com"});cloud.Save(state);
            var ssh=new SshStore();ssh.Put(new SshLogin{name="self",host="203.0.113.5",username="root"});ssh.Put(new SshLogin{name="desk",host="203.0.113.6",username="root"});ssh.Save(state);
            File.WriteAllText(Path.Combine(state,"cloudcli-kinds.json"),"{\"schema\":1,\"kinds\":{\"self\":\"self-hosted\",\"desk\":\"webdesktop\"}}");
            using(var form=new Manager(false,state,kit)){
                var started=new List<string>();form.StartChannel=login=>{started.Add(login.name);return true;};
                form.Show();Pump();
                foreach(var name in new[]{"self","desk"}){var p=form.Preferences.Get(name);p.loginMode="cloudcli";form.Cards[name].UpdatePreference(p);}
                form.RefreshState();Pump();
                check(form.StartAutoChannels()==1&&started.SequenceEqual(new[]{"self"}),"at start CMCP connects the SSH channel only for the self-hosted CloudCLI");
                var self=form.Cards["self"];var desk=form.Cards["desk"];
                check(self.SetupOffered&&self.Details.SetupShown&&!desk.SetupOffered&&!desk.Details.SetupShown,"only a CloudCLI that is not WebDesktop's offers the setup action");
                check(self.Details.Channel=="已停止"&&desk.Details.Channel==null,"a self-hosted CloudCLI shows its local tools channel in the details");
                self.SetExpanded(true,false);Pump();check(self.Details.Setup.Visible&&self.Details.Setup.Bottom<=self.Details.Open.Top&&self.Details.Setup.Right<=self.Details.Width&&form.LayoutFits(),"the setup button sits above the other detail buttons and fits");
                form.OpenEditor("self");Pump();var editor=form.Editor;
                check(editor!=null&&editor.AutoChannel.Checked,"the editor shows the channel switch on for a self-hosted CloudCLI");
                editor.ShowSsh();editor.HostInput.Box.Clear();editor.UserInput.Box.Clear();check(!editor.ValidateFields(),"a self-hosted CloudCLI cannot be saved without SSH details");
                editor.HostInput.Box.Text="203.0.113.5";editor.UserInput.Box.Text="root";check(editor.ValidateFields()&&editor.BuildSsh("self").sshAutoStart==null,"an untouched switch keeps following the CloudCLI kind");
                editor.AutoChannel.Checked=false;check(editor.BuildSsh("self").sshAutoStart==false,"turning the switch off is saved for this device");
                editor.Save.PerformClick();Pump();
                check(form.Editor==null&&SshStore.Load(state).Get("self").sshAutoStart==false,"the device keeps the user's channel choice");
                started.Clear();check(form.StartAutoChannels()==0&&started.Count==0,"a channel the user turned off does not start with CMCP");
                form.OpenEditor("desk");Pump();check(form.Editor!=null&&!form.Editor.AutoChannel.Checked,"WebDesktop CloudCLI devices keep the channel off by default");form.CloseEditor();Pump();
            }
        }
    }
}
