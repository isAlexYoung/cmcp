using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace CMCP {
    internal static class SshTests {
        static void Pump(){for(int i=0;i<4;i++){Application.DoEvents();System.Threading.Thread.Sleep(5);}}
        static SshLogin Sample(string secret="",string method="password",string key=""){return new SshLogin{name="dev'ice",host="203.0.113.24",port=2222,username="root",method=method,keyPath=key,secret=secret};}
        static bool ContainsText(Control c,string text){return c.Text.Contains(L.Text(text))||c.Controls.Cast<Control>().Any(child=>ContainsText(child,text));}
        static string Decoded(string arguments){string marker="-EncodedCommand ";int at=arguments.IndexOf(marker,StringComparison.Ordinal);string rest=arguments.Substring(at+marker.Length).Split(' ','"')[0];return Encoding.Unicode.GetString(Convert.FromBase64String(rest));}
        internal static void Run(string temp,Action<bool,string> check){
            Validation(check);Storage(temp,check);Answers(check);Commands(check);
            Channel(temp,check);
            RealScript(temp,check);RealAskpass(temp,check);
            Editor(temp,check);Window(check);RealFiles(temp,check);CardDisplay(check);
        }
        static void Validation(Action<bool,string> check){
            check(new[]{"example.com","a-b.example.com","203.0.113.24","2001:db8::1","h"}.All(SshLogin.ValidHost),"ordinary host names and addresses are accepted");
            check(!new[]{"","-oProxyCommand=x","a b","a;b","a&b","a'b","a\"b","a|b","$(x)","a\nb"}.Any(SshLogin.ValidHost),"a host cannot pass as an option or a shell separator");
            check(new[]{"root","a.b_c-d","user@domain"}.All(SshLogin.ValidUser)&&!new[]{"","-l","a b","a;b","a'b"}.Any(SshLogin.ValidUser),"user names cannot pass as an option or a shell separator");
            check(SshLogin.Problem("a.example","0","root","password","").Length>0&&SshLogin.Problem("a.example","65536","root","password","").Length>0&&SshLogin.Problem("a.example","x","root","password","").Length>0&&SshLogin.Problem("a.example","22","root","password","").Length==0,"ports stay between 1 and 65535");
            check(SshLogin.Problem("a.example","22","root","key","").Length>0&&SshLogin.Problem("a.example","22","root","other","").Length>0&&SshLogin.Problem("a.example","22","root","key",@"C:\keys\id").Length==0,"the key method needs a key path and unknown methods are refused");
        }
        static void Storage(string temp,Action<bool,string> check){
            string directory=Path.Combine(temp,"ssh-store");Directory.CreateDirectory(directory);
            string cipher=SshSecret.Protect("TESTONLY 口令");
            check(!cipher.Contains("TESTONLY")&&SshSecret.Unprotect(cipher)=="TESTONLY 口令","secrets are encrypted and come back exactly");
            var store=new SshStore();var login=Sample(cipher);login.active=true;store.Put(login);store.Save(directory);
            string file=SshStore.PathFor(directory);
            check(!File.ReadAllText(file).Contains("TESTONLY"),"the saved file never holds the password in plain text");
            var read=SshStore.Load(directory);var again=read.Get("dev'ice");
            check(!read.ReadError&&again!=null&&again.host==login.host&&again.port==2222&&again.active&&again.secret==cipher,"SSH details survive saving and loading");
            read.Rename("dev'ice","other");check(read.Get("dev'ice")==null&&read.Get("other")!=null,"a device can move to a new name");
            check(read.Remove("other")&&read.logins.Count==0&&!read.Remove("other"),"removing a device removes only its record");
            File.WriteAllText(file,"{broken");
            var broken=SshStore.Load(directory);bool refused=false;try{broken.Save(directory);}catch(IOException){refused=true;}
            check(broken.ReadError&&refused&&File.ReadAllText(file)=="{broken","a damaged file is refused and never overwritten");
            File.WriteAllText(file,"{\"schema\":1,\"logins\":[{\"name\":\"x\",\"host\":\"-oProxyCommand=x\",\"port\":22,\"username\":\"root\",\"method\":\"password\",\"keyPath\":\"\",\"secret\":\"\"}]}");
            check(SshStore.Load(directory).ReadError,"a hand-edited host that looks like an option is refused on load");
        }
        static void Answers(Action<bool,string> check){
            var password=Sample("x");var key=Sample("x","key",@"C:\Users\me\.ssh\id_ed25519");
            check(SshAskpass.Classify("root@203.0.113.24's password: ",password)==SshAskpass.Kind.Secret&&SshAskpass.Classify("(root@203.0.113.24) Password: ",password)==SshAskpass.Kind.Secret&&SshAskpass.Classify("Password: ",password)==SshAskpass.Kind.Secret,"the saved password answers this device's password prompts");
            check(SshAskpass.Classify("admin@203.0.113.24's password: ",password)==SshAskpass.Kind.Ask&&SshAskpass.Classify("root@198.51.100.7's password: ",password)==SshAskpass.Kind.Ask,"the saved password never answers for another user or server");
            check(SshAskpass.Classify("Verification code: ",password)==SshAskpass.Kind.Ask,"a one-time code goes to the user");
            check(SshAskpass.Classify("Enter passphrase for key 'C:\\\\Users\\\\me/.ssh/id_ed25519': ",key)==SshAskpass.Kind.Secret&&SshAskpass.Classify("Enter passphrase for key 'C:\\other\\id': ",key)==SshAskpass.Kind.Ask,"a saved passphrase answers only for its own key");
            check(SshAskpass.Classify("Are you sure you want to continue connecting (yes/no/[fingerprint])? ",password)==SshAskpass.Kind.Confirm,"an unknown host key is always left to the user");
            check(SshAskpass.Classify("root@203.0.113.24's password: ",null)==SshAskpass.Kind.Ask&&SshAskpass.Classify("root@203.0.113.24's password: ",Sample(""))==SshAskpass.Kind.Ask,"nothing saved means the user is asked");
        }
        static void Commands(Action<bool,string> check){
            var withSecret=Sample("x");var without=Sample("");
            string script=SshCommand.PowerShellScript(withSecret,@"C:\ssh.exe",@"C:\app's\CMCP.exe");
            check(script.Contains("$env:SSH_ASKPASS='C:\\app''s\\CMCP.exe'")&&script.Contains("$env:"+SshAskpass.Variable+"='dev''ice'")&&script.Contains("'--' '203.0.113.24'")&&script.Contains("'-p' '2222' '-l' 'root'"),"the PowerShell command quotes every value and ends options before the host");
            check(script.IndexOf("Remove-Item Env:SSH_ASKPASS",StringComparison.Ordinal)>script.IndexOf("& 'C:",StringComparison.Ordinal),"the shell forgets the password helper as soon as ssh ends");
            check(script.Contains("NumberOfPasswordPrompts=1"),"a wrong saved password is tried only once");
            string plain=SshCommand.PowerShellScript(without,@"C:\ssh.exe",@"C:\CMCP.exe");
            check(!plain.Contains("SSH_ASKPASS")&&!plain.Contains("NumberOfPasswordPrompts"),"with nothing saved ssh simply asks in the terminal");
            string keyed=SshCommand.PowerShellScript(Sample("","key",@"C:\my keys\id"),@"C:\ssh.exe",@"C:\CMCP.exe");
            check(keyed.Contains("'-i' 'C:\\my keys\\id' '-o' 'IdentitiesOnly=yes'"),"the chosen key is the only key offered");
            check(SshCommand.QuotePowerShell("a\u2019b")=="'a\u2019\u2019b'","typographic quotes cannot end a PowerShell string");
            string bash=SshCommand.BashScript(Sample("x","key",@"C:\it's\id"),@"C:\app\CMCP.exe");
            check(bash.Contains("SSH_ASKPASS='C:/app/CMCP.exe'")&&bash.Contains("'-i' 'C:/it'\\''s/id'")&&bash.Contains("unset SSH_ASKPASS")&&bash.EndsWith("exec bash -l"),"the Git Bash command uses forward slashes and quotes every value");
            Func<string,TerminalChoice> choice=id=>new TerminalChoice{Id=id,Label=id,Path=@"C:\"+id+".exe"};
            var wt=SshCommand.Start(choice("wt"),withSecret,@"C:\ssh.exe",@"C:\CMCP.exe");
            check(wt.Arguments.StartsWith("-w 0 new-tab --title \"root@203.0.113.24\"")&&wt.Arguments.Contains(" -- ")&&Decoded(wt.Arguments).Contains("'--' '203.0.113.24'")&&wt.UseShellExecute,"Windows Terminal opens a tab running the same command");
            var cmd=SshCommand.Start(choice("cmd"),withSecret,@"C:\ssh.exe",@"C:\CMCP.exe");
            check(cmd.Arguments.StartsWith("/d /k \"\"")&&Decoded(cmd.Arguments).Contains("'--' '203.0.113.24'"),"Command Prompt stays open after the same command");
            var shell=SshCommand.Start(choice("pwsh"),withSecret,@"C:\ssh.exe",@"C:\CMCP.exe");
            check(shell.FileName==@"C:\pwsh.exe"&&shell.Arguments.Contains("-NoExit")&&Decoded(shell.Arguments).Contains("'--' '203.0.113.24'"),"PowerShell stays open after the same command");
            var git=SshCommand.Start(choice("gitbash"),withSecret,null,@"C:\CMCP.exe");
            check(git.Arguments.StartsWith("--cd-to-home -c \"")&&git.Arguments.Contains("ssh '-p' '2222'"),"Git Bash runs its own ssh");
            check(!wt.Arguments.Contains("TESTONLY")&&!String.IsNullOrEmpty(wt.WorkingDirectory),"no secret reaches the command line and the program folder is not held open");
            var mcp=new SshCommand.McpLaunch{Node=@"C:\CMCP app\node.exe",Script=@"C:\CMCP app\ssh-terminal.mjs",Directory=@"C:\local user's data",Owner=123};
            string prepared=SshCommand.PowerShellScript(without,@"C:\ssh.exe",@"C:\CMCP.exe",mcp);
            check(prepared.Contains("ssh-terminal.mjs")&&prepared.Contains("'--owner' '123'")&&prepared.IndexOf("ssh-terminal.mjs")<prepared.IndexOf("& 'C:\\ssh.exe'"),"the terminal prepares a per-device background MCP before interactive SSH");
            check(prepared.Contains("SSH_ASKPASS_REQUIRE='force'")&&!prepared.Contains("TESTONLY")&&SshCommand.BashScript(without,@"C:\CMCP.exe",mcp).Contains("ssh-terminal.mjs"),"key, password and Git Bash terminals share MCP preflight without inline secrets");
            var found=Terminals.Detect();
            check(found.Any(t=>t.Id=="powershell")&&found.Any(t=>t.Id=="cmd")&&found.All(t=>File.Exists(t.Path)),"the built-in terminals are always offered and only installed ones are listed");
            check(Terminals.Resolve("wt",new List<TerminalChoice>{choice("cmd")}).Id=="cmd"&&Terminals.Resolve("cmd",new List<TerminalChoice>{choice("wt"),choice("cmd")}).Id=="cmd","an uninstalled choice falls back and a present choice is kept");
        }
        static Process Launch(string file,string arguments,IDictionary<string,string> variables){
            var start=new ProcessStartInfo(file,arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true,StandardOutputEncoding=Encoding.UTF8};
            foreach(var pair in variables)start.EnvironmentVariables[pair.Key]=pair.Value;
            return Process.Start(start);
        }
        // The real shell with a stand-in for ssh: every value must arrive as one argument, and the variables must be gone afterwards.
        static void RealScript(string temp,Action<bool,string> check){
            string folder=Path.Combine(temp,"ssh it's");Directory.CreateDirectory(folder);
            string fake=Path.Combine(folder,"fake-ssh.ps1"),result=Path.Combine(folder,"seen.txt");
            string report=SshCommand.QuotePowerShell(result);
            File.WriteAllText(fake,"$args.Count | Out-File -LiteralPath "+report+" -Encoding utf8\n$args | Out-File -LiteralPath "+report+" -Encoding utf8 -Append\n$env:SSH_ASKPASS_REQUIRE | Out-File -LiteralPath "+report+" -Encoding utf8 -Append\n",new UTF8Encoding(true));
            var login=Sample("x","key",Path.Combine(folder,"my key"));
            string script=SshCommand.PowerShellScript(login,fake,@"C:\CMCP.exe").Replace("$Host.UI.RawUI.WindowTitle='root@203.0.113.24'\n","")+"\"after=[$env:SSH_ASKPASS][$env:"+SshAskpass.Variable+"]\"\n";
            using(var run=Launch(Terminals.WindowsPowerShell,"-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand "+SshCommand.Encoded(script),new Dictionary<string,string>())){
                run.StandardInput.Close();var output=run.StandardOutput.ReadToEndAsync();var errors=run.StandardError.ReadToEndAsync();
                if(!run.WaitForExit(30000)){run.Kill();throw new Exception("ssh script timed out");}
                var seen=File.ReadAllLines(result);
                check(seen[0].Trim()=="10"&&seen.Contains(login.keyPath)&&seen[seen.Length-2]=="203.0.113.24"&&seen[seen.Length-3]=="--"&&seen[seen.Length-1]=="force","a key path with spaces and quotes reaches ssh as one argument, with the host last");
                check(output.Result.Contains("after=[][]"),"the password helper variables are gone once ssh ends");
            }
        }
        // Real OpenSSH asking this very program for a passphrase, then checking the key really opened.
        static void RealAskpass(string temp,Action<bool,string> check){
            string keygen=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"OpenSSH\ssh-keygen.exe");
            check(File.Exists(keygen),"OpenSSH is available for the real password helper check");
            string state=Path.Combine(temp,"ssh-askpass");Directory.CreateDirectory(state);
            string key=Path.Combine(state,"id_test"),phrase="TESTONLY 口令 123";
            using(var make=Process.Start(new ProcessStartInfo(keygen,"-q -t ed25519 -N \""+phrase+"\" -f \""+key+"\""){UseShellExecute=false,CreateNoWindow=true})){if(!make.WaitForExit(30000)){make.Kill();throw new Exception("ssh-keygen timed out");}check(make.ExitCode==0,"a throwaway protected key is created");}
            var store=new SshStore();store.Put(new SshLogin{name="helper",host="203.0.113.24",username="root",method="key",keyPath=key,secret=SshSecret.Protect(phrase)});store.Save(state);
            var variables=new Dictionary<string,string>{{"SSH_ASKPASS",Program.ExecutablePath},{"SSH_ASKPASS_REQUIRE","force"},{SshAskpass.Variable,"helper"},{"CMCP_STATE_DIR",state}};
            using(var read=Launch(keygen,"-y -f \""+key+"\"",variables)){
                read.StandardInput.Close();var output=read.StandardOutput.ReadToEndAsync();read.StandardError.ReadToEndAsync();
                if(!read.WaitForExit(30000)){foreach(var stray in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Program.ExecutablePath)))if(stray.Id!=Process.GetCurrentProcess().Id&&String.Equals(stray.MainModule.FileName,Program.ExecutablePath,StringComparison.OrdinalIgnoreCase))stray.Kill();read.Kill();throw new Exception("real password helper timed out");}
                check(read.ExitCode==0&&output.Result.Contains(File.ReadAllText(key+".pub").Split(' ')[1]),"real OpenSSH opens the key with the passphrase this program supplies");
            }
        }
        static void Editor(string temp,Action<bool,string> check){
            using(var page=new TargetEditorPage(new Target{Name="",Url=""},new CardPreference(),Palette.Create(true))){
                check(!page.ValidateFields(),"a device needs at least one way to sign in");
                check(page.CurrentCategory!="常规","the page moves to where the missing details belong");
                page.HostInput.Box.Text="203.0.113.24";page.UserInput.Box.Text="root";
                check(page.ValidateFields()&&page.HasSsh&&!page.HasWeb,"a device can have SSH only, with no web address");
                page.PortInput.Box.Text="70000";check(!page.ValidateFields()&&page.CurrentCategory=="SSH 登录","a bad port stays on the SSH page");page.PortInput.Box.Text="2222";
                page.SshSecretInput.Box.Text="TESTONLY";var built=page.BuildSsh("a");
                check(built.port==2222&&built.active&&built.secret.Length>0&&!built.secret.Contains("TESTONLY")&&SshSecret.Unprotect(built.secret)=="TESTONLY","a typed password is saved encrypted");
                page.MethodField.Choose("key");
                check(!page.ValidateFields()&&page.KeyInput.Enabled,"the key method needs a key and enables its field");
                string key=Path.Combine(temp,"ssh-editor-key");File.WriteAllText(key,"x");File.WriteAllText(key+".pub","x");
                page.KeyInput.Box.Text=key+".pub";check(!page.ValidateFields(),"a public key is refused with its own message");
                page.KeyInput.Box.Text=key+".missing";check(!page.ValidateFields(),"a missing key file is refused");
                page.KeyInput.Box.Text=key;check(page.ValidateFields(),"an existing private key is accepted");
                page.MethodField.Choose("password");check(!page.KeyInput.Enabled,"the private key row is greyed out for password sign-in");
            }
            var saved=Sample(SshSecret.Protect("TESTONLY"));saved.name="s";saved.active=true;
            using(var page=new TargetEditorPage(new Target{Name="s",Url="https://auto.invalid"},new CardPreference(),Palette.Create(false),saved)){
                check(page.SshSecretInput.Box.Text.Length==0&&page.PreferSsh,"editing shows no saved password and keeps the chosen sign-in");
                check(page.BuildSsh("s").secret==saved.secret,"leaving the password blank keeps it");
                page.HostInput.Box.Text="198.51.100.7";check(page.BuildSsh("s").secret.Length==0,"a saved password is never carried over to another server");
                page.HostInput.Box.Text=saved.host;check(page.BuildSsh("s").secret==saved.secret,"going back to the same server keeps it");
                page.MethodField.Choose("key");page.KeyInput.Box.Text=@"C:\k";check(page.BuildSsh("s").secret.Length==0,"a saved password never becomes a key passphrase");
                page.MethodField.Choose("password");
                page.UserInput.Box.Clear();page.HostInput.Box.Clear();check(page.BuildSsh("s")==null&&page.ValidateFields(),"clearing the SSH details leaves a web-only device");
            }
        }
        // The real save path: nothing reaches the backend's files and the device survives a restart.
        static void RealFiles(string temp,Action<bool,string> check){
            string state=Path.Combine(temp,"ssh-real"),kit=Path.Combine(state,"kit");Directory.CreateDirectory(kit);
            using(var form=new Manager(false,state,kit)){
                form.Show();Pump();form.OpenAdd();Pump();form.Editor.ShowSsh();Pump();
                form.Editor.HostInput.Box.Text="192.0.2.9";form.Editor.UserInput.Box.Text="root";form.Editor.SshSecretInput.Box.Text="TESTONLY";form.Editor.HideAddress.Checked=true;form.Editor.Save.PerformClick();Pump();
                check(form.Editor==null&&form.Cards.Count==1&&form.Cards.Values.First().SshActive,"a device with only SSH saves without any backend worker");
                string file=SshStore.PathFor(state);
                check(File.Exists(file)&&!File.ReadAllText(file).Contains("TESTONLY"),"the password reaches the disk only in encrypted form");
                check(!File.Exists(Path.Combine(state,"cloudpc-targets.json"))&&!File.Exists(Path.Combine(state,"target-controls.json")),"an SSH-only device never enters the backend's target files");
                ProcessStartInfo started=null;form.StartTerminal=info=>started=info;form.Options.terminal="cmd";
                form.Cards.Values.First().Connect.PerformClick();Pump();
                check(started!=null&&started.Arguments.StartsWith("/d /k")&&Decoded(started.Arguments).Contains("'192.0.2.9'")&&!started.Arguments.Contains("TESTONLY"),"the card's button opens the chosen terminal with this device's address");
                form.Cards.Values.First().LoginSwitch.PerformClick();Pump();check(!form.Cards.Values.First().SshActive,"an SSH-only device can persist web as its selected mode");
                started=null;form.Cards.Values.First().Connect.PerformClick();Pump();check(started==null&&ContainsText(form,"还没有填写共享网页地址，请编辑设备后再连接。"),"missing web details never open the SSH terminal");
            }
            using(var again=new Manager(false,state,kit)){
                again.Show();Pump();var card=again.Cards.Values.FirstOrDefault();
                check(card!=null&&!card.SshActive&&card.Preference.loginMode=="web"&&card.Preference.hideAddress&&card.Ssh.Address=="root@192.0.2.9:22"&&card.Ssh.secret.Length>0,"the selected mode and untouched SSH password survive a restart");
            }
        }
        static void CardDisplay(Action<bool,string> check){
            using(var form=new Manager(true)){
                form.Show();Pump();var card=form.Cards["preview-b"];
                check(card.Address==card.Target.Url,"web mode exposes only the web address for display and copying");
                card.LoginSwitch.PerformClick();Pump();check(card.Address==card.Ssh.host&&!card.Address.Contains("@"),"SSH mode displays and copies the host without user, port or command");
                check(form.Cards["preview-a"].Top<card.Top,"switching sign-in preserves the existing card order");
                form.OpenEditor(card.Target.Name);Pump();form.Editor.HideAddress.Checked=true;form.Editor.NoteInput.Box.Text="Private device note";form.Editor.NameInput.Box.Text="Work device";form.Editor.Save.PerformClick();Pump();
                check(form.Editor==null&&card.Preference.hideAddress&&card.Caption=="Work device"&&card.IconNote.AccessibleDescription=="Private device note"&&card.Details.Note=="","hidden address and icon note save without adding a note to the detail panel");
                card.LoginSwitch.PerformClick();Pump();check(card.Preference.hideAddress&&card.Address==card.Target.Url,"changing sign-in retains address hiding while copying still uses the current address");
                form.OpenEditor(card.Target.Name);Pump();var page=form.Editor;
                check(page.HideAddress.Checked&&page.HideAddress.Right==page.HideAddress.Parent.Width-16,"editing restores the saved display switch and aligns it at the right edge");
                page.ShowWeb();Pump();check(page.Remember.Right==page.Remember.Parent.Width-16,"remember-password switch uses the same right edge");
                page.ShowGeneral();page.HideAddress.Checked=false;page.Save.PerformClick();Pump();check(!card.Preference.hideAddress,"turning hiding off restores the address without changing the device");
            }
        }
        // The record format and pipe protocol belong to app/ssh-terminal.mjs.
        static void Channel(string temp,Action<bool,string> check){
            check(SshWorkers.Key(@"F:\state","device")=="d9f86b451aa7791821a1e3c3f5a87771452b430dac0f03e40012326c2eebca66","the channel key matches the one the worker computes");
            string state=Path.Combine(temp,"ssh-channel"),folder=Path.Combine(state,"ssh-mcp");Directory.CreateDirectory(folder);
            string file=SshWorkers.RecordFile(state,"d");
            check(SshWorkers.State(state,"d")=="","no record means the channel is stopped");
            long now=(DateTime.UtcNow.Ticks-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).Ticks)/TimeSpan.TicksPerMillisecond;int self=Process.GetCurrentProcess().Id;
            Action<int,long,string> record=(pid,at,phase)=>File.WriteAllText(file,"{\"pid\":"+pid+",\"at\":"+at+",\"state\":\""+phase+"\",\"token\":\""+new string('a',64)+"\"}");
            record(self,now,"ready");check(SshWorkers.State(state,"d")=="ready","a fresh record reports its phase");
            record(self,now-60000,"ready");check(SshWorkers.State(state,"d")=="","a record nobody refreshes counts as stopped");
            record(1999999,now,"ready");check(SshWorkers.State(state,"d")=="","a record from a dead process counts as stopped");
            File.WriteAllText(file,"{broken");check(SshWorkers.State(state,"d")==null,"an unreadable record keeps the last known state");
            record(self,now,"ready");check(!SshWorkers.Stop(state,"d",200),"stopping reports failure when no worker answers");
            string received=null;
            var server=new System.Threading.Thread(()=>{using(var pipe=new System.IO.Pipes.NamedPipeServerStream("cmcp-ssh-"+SshWorkers.Key(state,"d"),System.IO.Pipes.PipeDirection.InOut)){pipe.WaitForConnection();var bytes=new List<byte>();for(int b=pipe.ReadByte();b>=0&&b!='\n';b=pipe.ReadByte())bytes.Add((byte)b);received=Encoding.UTF8.GetString(bytes.ToArray());var reply=Encoding.UTF8.GetBytes("{}\n");pipe.Write(reply,0,reply.Length);pipe.Flush();pipe.WaitForPipeDrain();}}){IsBackground=true};server.Start();
            bool stopped=SshWorkers.Stop(state,"d",3000);server.Join(3000);
            check(stopped&&received!=null&&received.Contains(new string('a',64))&&received.Contains("\"action\":\"stop\""),"stopping sends the worker's token and the stop action");
        }
        static void Window(Action<bool,string> check){
            using(var form=new Manager(true)){
                form.Show();Pump();
                var a=form.Cards["preview-a"];var b=form.Cards["preview-b"];
                check(b.Ssh!=null&&!b.SshActive&&b.LoginSwitch.Text=="网页"&&a.Ssh==null,"a card starts on shared web sign-in");
                string state=b.Target.State;
                b.TestHover(true);Pump();check(b.LoginSwitch.Visible&&b.ActionsVisible&&b.LoginSwitch.Right<=b.Connect.Left,"the switch sits beside the connect button");
                b.SetExpanded(true,false);Pump();check(b.Details.Stop.Visible,"web sign-in offers stop in the details");
                b.LoginSwitch.PerformClick();Pump();
                check(b.SshActive&&b.LoginSwitch.Text=="SSH"&&b.Connect.Text=="打开终端"&&b.Connect.Glyph=="terminal"&&b.Target.State==state,"switching changes the card's button and leaves the web connection alone");
                check(b.Details.Stop.Visible&&!b.Details.Stop.Enabled&&b.Details.Open.Text=="打开终端"&&b.StatusText.Text=="ssh · 已停止","a stopped SSH channel shows its state and has nothing to stop");
                b.Connect.PerformClick();Pump();check(b.Target.State==state,"opening a terminal never starts the web connection");
                b.LoginSwitch.PerformClick();Pump();check(!b.SshActive&&b.Connect.Text!="打开终端"&&b.Details.Stop.Visible,"switching back restores shared web sign-in");b.SetExpanded(false,false);Pump();
                var channels=new Dictionary<string,string>();var stops=new List<string>();bool stopWorks=true;
                form.ReadSshState=(directory,id)=>{string phase;return channels.TryGetValue(id,out phase)?phase:"";};
                form.StopSshWorker=(directory,id)=>{stops.Add(id);if(stopWorks)channels.Remove(id);return stopWorks;};
                b.LoginSwitch.PerformClick();Pump();b.SetExpanded(true,false);
                channels["preview-b"]="connecting";form.RefreshState();Pump();check(b.StatusText.Text=="ssh · 连接中"&&b.Details.Stop.Enabled,"a starting SSH channel can already be stopped");
                channels["preview-b"]="recovering";form.RefreshState();Pump();check(b.StatusText.Text=="ssh · 正在恢复","a recovering SSH channel says so");
                channels["preview-b"]="failed";form.RefreshState();Pump();check(b.StatusText.Text=="ssh · 连接异常"&&b.Details.Stop.Enabled,"a failed SSH channel can still be stopped");
                channels["preview-b"]="ready";form.RefreshState();Pump();
                check(b.StatusText.Text=="ssh · 已连接"&&b.StatusText.ForeColor.ToArgb()==b.Colors.Success.ToArgb()&&b.Details.Stop.Enabled&&b.Details.Stop.Visible,"a ready SSH channel shows as connected and can be stopped");
                check(b.Target.State==state&&b.Details.Logs.Left>b.Details.Stop.Right,"the stop button sits where shared web sign-in has it");
                stopWorks=false;b.Details.Stop.PerformClick();for(int i=0;i<100&&b.SshStopping;i++)Pump();
                check(stops.Count==1&&b.StatusText.Text=="ssh · 已连接"&&b.Details.Stop.Enabled,"a failed stop leaves the channel shown as connected");
                stopWorks=true;b.Details.Stop.PerformClick();for(int i=0;i<100&&b.SshStopping;i++)Pump();form.RefreshState();Pump();
                check(stops.Count==2&&stops.All(id=>id=="preview-b")&&b.StatusText.Text=="ssh · 已停止"&&!b.Details.Stop.Enabled&&b.Target.State==state,"stopping affects only this device's SSH channel, never its web connection");
                b.Details.Stop.PerformClick();Pump();check(stops.Count==2,"there is nothing to stop once the channel has stopped");
                b.LoginSwitch.PerformClick();Pump();check(b.StatusText.Text.StartsWith("web · "),"switching back shows the web state");b.SetExpanded(false,false);Pump();
                a.LoginSwitch.PerformClick();Pump();
                check(form.Editor==null&&a.SshActive&&a.Ssh==null,"a card without SSH details switches without opening the editor");
                a.Connect.PerformClick();Pump();check(form.Editor==null&&ContainsText(form,"还没有填写 SSH 信息，请编辑设备后再连接。")&&a.Target.State=="connected","missing SSH details are reported only when connecting and retain the running web link");
                form.OpenEditor(a.Target.Name);form.Editor.ShowSsh();
                form.Editor.HostInput.Box.Text="198.51.100.7";form.Editor.UserInput.Box.Text="root";form.Editor.Save.PerformClick();Pump();
                check(form.Editor==null&&a.Ssh!=null&&a.Ssh.host=="198.51.100.7"&&a.Target.State=="connected","SSH details save without touching a running connection");
                int before=form.Cards.Count;form.OpenAdd();Pump();form.Editor.ShowSsh();form.Editor.NameInput.Box.Text="我的 VPS";form.Editor.HostInput.Box.Text="192.0.2.9";form.Editor.UserInput.Box.Text="root";form.Editor.Save.PerformClick();Pump();
                var only=form.Cards.Values.FirstOrDefault(c=>c.Target.Url.Length==0);
                check(form.Editor==null&&form.Cards.Count==before+1&&only!=null&&only.SshActive&&only.Caption=="我的 VPS"&&only.Connect.Text=="打开终端","a device with only SSH gets its own card");
                check(only.Ssh.Address=="root@192.0.2.9:22"&&only.AccessibleName.StartsWith("我的 VPS"),"an SSH-only card shows its address and needs no web address");
                only.LoginSwitch.PerformClick();Pump();check(form.Editor==null&&!only.SshActive,"an SSH-only card switches to web without opening the editor");
                only.Connect.PerformClick();Pump();check(ContainsText(form,"还没有填写共享网页地址，请编辑设备后再连接。")&&only.Target.State=="stopped","missing web details are reported on connect without starting the backend");only.LoginSwitch.PerformClick();Pump();
                form.FinishTransition();Pump();
                check(form.TrayItems.Length>0,"the tray still builds with an SSH-only device");
                form.TrayAction(only.Target.Name,"connect");Pump();check(only.Target.State=="stopped","connecting from the tray only opens a terminal for an SSH-only device");
                only.Delete.PerformClick();Pump();check(!form.Cards.ContainsKey(only.Target.Name)&&form.Ssh.Get(only.Target.Name)==null,"deleting an SSH-only device removes its details");
                form.OpenSettings();Pump();
                var fields=form.Settings.Viewport.Controls[0].Controls.OfType<DropdownField>().ToArray();
                check(fields.Length==2&&fields[1].Value==Terminals.Resolve("",Terminals.Detect()).Id,"settings show a terminal dropdown beside the language one");
                fields[1].Choose("cmd");Pump();check(form.Options.terminal=="cmd"&&fields[1].Value=="cmd","the chosen terminal is kept");
                form.CloseSettings();Pump();form.FinishTransition();
            }
        }
    }
}
