using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CMCP {
    // SSH credentials remain separate from web targets. A dedicated background
    // SSH worker prepares Claude Code MCP before the visible terminal opens.
    internal sealed class SshLogin {
        public string name="",host="",username="",method="password",keyPath="",secret="";
        public int port=22;
        public bool active;
        internal bool UsesKey{get{return method=="key";}}
        internal string Address{get{return username+"@"+host+":"+port;}}
        internal string CopyCommand{get{return "ssh -p "+port+(UsesKey?" -i \""+keyPath+"\"":"")+" "+username+"@"+host;}}
        internal SshLogin Copy(){return (SshLogin)MemberwiseClone();}
        // Empty when usable, otherwise the message for the editor.
        internal static string Problem(string host,string port,string username,string method,string keyPath){
            if(!ValidHost(host))return "请输入正确的主机地址（域名或 IP）。";
            int number;if(!Int32.TryParse(port,out number)||number<1||number>65535)return "端口必须是 1 到 65535 之间的数字。";
            if(!ValidUser(username))return "请输入正确的用户名。";
            if(method!="password"&&method!="key")return "认证方法无效。";
            if(method=="key"&&!ValidKeyPath(keyPath))return "请选择私钥文件。";
            return "";
        }
        // Each value reaches a command line, so nothing may look like an option or a separator.
        internal static bool ValidHost(string value){
            if(String.IsNullOrEmpty(value)||value.Length>253)return false;
            if(value.Contains(":"))return Regex.IsMatch(value,@"\A[0-9A-Fa-f:.]+\z");
            return Regex.IsMatch(value,@"\A[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\z");
        }
        internal static bool ValidUser(string value){return !String.IsNullOrEmpty(value)&&value.Length<=64&&Regex.IsMatch(value,@"\A[A-Za-z0-9_][A-Za-z0-9._@-]*\z");}
        internal static bool ValidKeyPath(string value){
            if(String.IsNullOrEmpty(value)||value.Length>512||value.Any(Char.IsControl)||value.Contains("\""))return false;
            try{return Path.IsPathRooted(value)&&value.IndexOfAny(Path.GetInvalidPathChars())<0;}catch{return false;}
        }
    }
    internal static class SshSecret {
        static readonly byte[] Entropy=Encoding.UTF8.GetBytes("CMCP-SSH-v1");
        internal static string Protect(string text){return Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(text),Entropy,DataProtectionScope.CurrentUser));}
        internal static string Unprotect(string cipher){return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(cipher),Entropy,DataProtectionScope.CurrentUser));}
    }
    // Corrupt or unknown data is refused and never silently replaced, like the other state files.
    internal sealed class SshStore {
        public int schema=1;
        public List<SshLogin> logins=new List<SshLogin>();
        internal bool ReadError;
        internal const int MaxBytes=512*1024,MaxLogins=100;
        internal static string PathFor(string directory){return Path.Combine(directory,"ssh-logins.json");}
        internal static SshStore Load(string directory){
            string file=PathFor(directory);
            try{
                if(!File.Exists(file))return new SshStore();
                if(new FileInfo(file).Length>MaxBytes)throw new InvalidDataException();
                var data=new JavaScriptSerializer{MaxJsonLength=MaxBytes,RecursionLimit=8}.Deserialize<SshStore>(File.ReadAllText(file,Encoding.UTF8));
                if(data==null||data.schema!=1||data.logins==null||data.logins.Count>MaxLogins)throw new InvalidDataException();
                var seen=new HashSet<string>(StringComparer.Ordinal);
                foreach(var login in data.logins){
                    if(login==null||String.IsNullOrEmpty(login.name)||login.name.Length>512||!seen.Add(login.name)||login.secret==null||login.secret.Length>8192||login.keyPath==null)throw new InvalidDataException();
                    if(SshLogin.Problem(login.host,Convert.ToString(login.port),login.username,login.method,login.keyPath).Length>0)throw new InvalidDataException();
                }
                return data;
            }catch{return new SshStore{ReadError=true};}
        }
        internal SshLogin Get(string name){return logins.FirstOrDefault(l=>l.name==name);}
        internal void Put(SshLogin login){int index=logins.FindIndex(l=>l.name==login.name);if(index>=0)logins[index]=login;else logins.Add(login);}
        internal bool Remove(string name){return logins.RemoveAll(l=>l.name==name)>0;}
        internal void Rename(string from,string to){var login=Get(from);if(login!=null)login.name=to;}
        internal void Save(string directory){
            if(ReadError)throw new IOException("SSH 配置文件损坏，未覆盖原文件。");
            string json=new JavaScriptSerializer{MaxJsonLength=MaxBytes}.Serialize(this);
            if(Encoding.UTF8.GetByteCount(json)>MaxBytes)throw new IOException("SSH 配置文件过大。");
            Directory.CreateDirectory(directory);
            string key;using(var hash=SHA256.Create())key=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToLowerInvariant()))).Replace("-","").Substring(0,20);
            using(var mutex=new Mutex(false,"Local\\CmcpSsh-"+key)){
                bool held=false;string file=PathFor(directory),temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
                try{
                    try{held=mutex.WaitOne(2000);}catch(AbandonedMutexException){held=true;}
                    if(!held)throw new IOException("SSH 配置正在保存，请稍后再试。");
                    if(File.Exists(file)&&Load(directory).ReadError)throw new IOException("SSH 配置文件损坏，未覆盖原文件。");
                    File.WriteAllText(temporary,json,new UTF8Encoding(false));
                    if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);
                }finally{if(File.Exists(temporary))File.Delete(temporary);if(held)mutex.ReleaseMutex();}
            }
        }
    }
    internal sealed class TerminalChoice {internal string Id,Label,Path;}
    internal static class Terminals {
        internal static string OnPath(string file){
            foreach(string folder in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')){
                try{if(folder.Length>0&&File.Exists(Path.Combine(folder.Trim().Trim('"'),file)))return Path.Combine(folder.Trim().Trim('"'),file);}catch(ArgumentException){}
            }
            return null;
        }
        internal static string FirstExisting(params string[] candidates){return candidates.FirstOrDefault(c=>!String.IsNullOrEmpty(c)&&File.Exists(c));}
        static string RegistryGit(){
            foreach(var hive in new[]{Registry.CurrentUser,Registry.LocalMachine}){
                try{using(var key=hive.OpenSubKey(@"SOFTWARE\GitForWindows")){string root=key==null?null:key.GetValue("InstallPath") as string;if(!String.IsNullOrEmpty(root))return Path.Combine(root,"git-bash.exe");}}catch{}
            }
            return null;
        }
        internal static string WindowsPowerShell{get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");}}
        // Only what is really installed is offered. Windows PowerShell and cmd ship with Windows.
        internal static List<TerminalChoice> Detect(){
            var found=new List<TerminalChoice>();
            Action<string,string,string> add=(id,label,path)=>{if(!String.IsNullOrEmpty(path))found.Add(new TerminalChoice{Id=id,Label=label,Path=path});};
            add("wt","Windows Terminal",OnPath("wt.exe")??FirstExisting(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"Microsoft\WindowsApps\wt.exe")));
            add("powershell","Windows PowerShell",FirstExisting(WindowsPowerShell));
            add("pwsh","PowerShell 7",OnPath("pwsh.exe")??FirstExisting(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),@"PowerShell\7\pwsh.exe")));
            add("cmd","命令提示符",FirstExisting(Environment.GetEnvironmentVariable("ComSpec"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe")));
            string git=OnPath("git.exe");
            add("gitbash","Git Bash",FirstExisting(RegistryGit(),git==null?null:Path.GetFullPath(Path.Combine(Path.GetDirectoryName(git),@"..\git-bash.exe")),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),@"Git\git-bash.exe")));
            return found;
        }
        // A saved choice that was uninstalled later falls back to the first one found.
        internal static TerminalChoice Resolve(string id,List<TerminalChoice> found){return found.FirstOrDefault(t=>t.Id==id)??found.FirstOrDefault();}
    }
    internal static class SshCommand {
        internal sealed class McpLaunch {
            internal string Node,Script,Directory;
            internal int Owner;
            internal string[] Arguments(SshLogin login,string ssh){return new[]{Script,"--state",Directory,"--id",login.name,"--owner",Owner.ToString(),"--ssh",ssh??"ssh"};}
        }
        internal static string FindSsh(){return Terminals.FirstExisting(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"OpenSSH\ssh.exe"))??Terminals.OnPath("ssh.exe");}
        // PowerShell also treats typographic quotes as quotes, so those are doubled too.
        internal static string QuotePowerShell(string value){return "'"+Regex.Replace(value,"['\u2018\u2019\u201a\u201b]","$0$0")+"'";}
        internal static string QuoteBash(string value){return "'"+value.Replace("'","'\\''")+"'";}
        static bool HasSecret(SshLogin login){return !String.IsNullOrEmpty(login.secret);}
        // A saved password may answer one prompt only, so a wrong one cannot lock the account out.
        // Without a saved secret ssh simply asks in the terminal.
        internal static List<string> Options(SshLogin login,Func<string,string> path){
            var options=new List<string>{"-p",Convert.ToString(login.port),"-l",login.username};
            if(login.UsesKey){options.AddRange(new[]{"-i",path(login.keyPath),"-o","IdentitiesOnly=yes"});}
            else if(HasSecret(login))options.AddRange(new[]{"-o","PubkeyAuthentication=no","-o","PreferredAuthentications=keyboard-interactive,password","-o","NumberOfPasswordPrompts=1"});
            options.Add("--");options.Add(login.host);
            return options;
        }
        // sessions: the folder where a terminal that closes on disconnect records its shell (SshSessions).
        internal static string PowerShellScript(SshLogin login,string ssh,string askpass,McpLaunch mcp=null,string sessions=null){
            var text=new StringBuilder();bool secret=HasSecret(login)||mcp!=null;
            text.Append("$Host.UI.RawUI.WindowTitle="+QuotePowerShell(login.username+"@"+login.host)+"\n");
            if(sessions!=null)text.Append("$cmcpSession=Join-Path "+QuotePowerShell(sessions)+" ([string]$PID+'.pid');[void](New-Item -ItemType Directory -Force -Path "+QuotePowerShell(sessions)+");Set-Content -LiteralPath $cmcpSession -Value ''\n");
            if(secret){
                text.Append("$env:SSH_ASKPASS="+QuotePowerShell(askpass)+";$env:SSH_ASKPASS_REQUIRE='force';$env:"+SshAskpass.Variable+"="+QuotePowerShell(login.name)+"\n");
                string state=Environment.GetEnvironmentVariable("CMCP_STATE_DIR");
                if(state!=null)text.Append("$env:CMCP_STATE_DIR="+QuotePowerShell(state)+"\n");
            }
            if(mcp!=null){
                text.Append("$env:CMCP_STATE_DIR="+QuotePowerShell(mcp.Directory)+"\n");
                text.Append("& "+QuotePowerShell(mcp.Node)+" "+String.Join(" ",mcp.Arguments(login,ssh).Select(QuotePowerShell))+"\n");
                text.Append("if($LASTEXITCODE -ne 0){Write-Warning 'MCP 尚未就绪；仍可进入 SSH 终端检查服务器。'}\n");
            }
            text.Append("& "+QuotePowerShell(ssh)+" "+String.Join(" ",Options(login,p=>p).Select(QuotePowerShell))+"\n");
            if(sessions!=null)text.Append("$cmcpCode=$LASTEXITCODE\n");
            // The shell stays open afterwards; another ssh typed there must not receive this device's password.
            if(secret)text.Append("Remove-Item Env:SSH_ASKPASS,Env:SSH_ASKPASS_REQUIRE,Env:"+SshAskpass.Variable+" -ErrorAction SilentlyContinue\n");
            // A disconnect ends ssh with code 0 and the window closes. A failed login waits, so its message can be read.
            if(sessions!=null)text.Append("Remove-Item -LiteralPath $cmcpSession -ErrorAction SilentlyContinue\nif($cmcpCode -ne 0){[void](Read-Host "+QuotePowerShell(L.Text("SSH 已结束，按回车键关闭窗口"))+")}\nexit 0\n");
            return text.ToString();
        }
        internal static string BashScript(SshLogin login,string askpass,McpLaunch mcp=null,string sessions=null){
            Func<string,string> slashes=p=>p.Replace('\\','/');
            var text=new StringBuilder();bool secret=HasSecret(login)||mcp!=null;
            // The Windows PID of this bash, which is the parent of the ssh it runs.
            if(sessions!=null)text.Append("mkdir -p "+QuoteBash(slashes(sessions))+"; cmcp_session="+QuoteBash(slashes(sessions))+"/$(cat /proc/$$/winpid).pid; : > \"$cmcp_session\"; ");
            if(secret){
                text.Append("export SSH_ASKPASS="+QuoteBash(slashes(askpass))+" SSH_ASKPASS_REQUIRE=force "+SshAskpass.Variable+"="+QuoteBash(login.name)+"; ");
                string state=Environment.GetEnvironmentVariable("CMCP_STATE_DIR");
                if(state!=null)text.Append("export CMCP_STATE_DIR="+QuoteBash(state)+"; ");
            }
            if(mcp!=null){
                text.Append("export CMCP_STATE_DIR="+QuoteBash(slashes(mcp.Directory))+"; ");
                text.Append(QuoteBash(slashes(mcp.Node))+" "+String.Join(" ",mcp.Arguments(login,"ssh").Select((v,i)=>QuoteBash(i==0||i==2?slashes(v):v)))+" || printf '%s\\n' 'MCP 尚未就绪；仍可进入 SSH 终端检查服务器。'; ");
            }
            text.Append("ssh "+String.Join(" ",Options(login,slashes).Select(QuoteBash))+"; ");
            if(sessions!=null)text.Append("cmcp_code=$?; ");
            if(secret)text.Append("unset SSH_ASKPASS SSH_ASKPASS_REQUIRE "+SshAskpass.Variable+"; ");
            if(sessions!=null)text.Append("rm -f \"$cmcp_session\"; [ $cmcp_code -eq 0 ] || read -r -p "+QuoteBash(L.Text("SSH 已结束，按回车键关闭窗口"))+"; exit 0");
            else text.Append("exec bash -l");
            return text.ToString();
        }
        internal static string Encoded(string script){return Convert.ToBase64String(Encoding.Unicode.GetBytes(script));}
        // With sessions the shell ends with ssh, so the window can close; without, it stays for the user.
        internal static ProcessStartInfo Start(TerminalChoice terminal,SshLogin login,string ssh,string askpass,McpLaunch mcp=null,string sessions=null){
            string home=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            // Through the shell, so every terminal gets a window of its own whoever started this program.
            var start=new ProcessStartInfo(terminal.Path){UseShellExecute=true,WorkingDirectory=home};
            string shell=" -NoLogo -NoProfile",stay=sessions==null?" -NoExit":"",encoded=terminal.Id=="gitbash"?"":" -EncodedCommand "+Encoded(PowerShellScript(login,ssh,askpass,mcp,sessions));
            switch(terminal.Id){
                case "wt":start.Arguments="-w 0 new-tab --title \""+login.username+"@"+login.host+"\" -d \""+home+"\" -- \""+Terminals.WindowsPowerShell+"\""+shell+stay+encoded;break;
                case "cmd":start.Arguments=(sessions==null?"/d /k":"/d /c")+" \"\""+Terminals.WindowsPowerShell+"\""+shell+encoded+"\"";break;
                case "gitbash":start.Arguments="--cd-to-home -c \""+BashScript(login,askpass,mcp,sessions).Replace("\"","\\\"")+"\"";break;
                default:start.Arguments=shell.TrimStart()+stay+encoded;break;
            }
            return start;
        }
    }
    // ssh runs this program with the prompt as its only argument and reads the answer from stdout.
    internal static class SshAskpass {
        internal const string Variable="CMCP_SSH_ASKPASS";
        internal enum Kind {Secret,Confirm,Ask}
        // The saved secret only answers the exact prompt for this device. Anything else goes to the user.
        internal static Kind Classify(string prompt,SshLogin login){
            string text=(prompt??"").Trim();
            if(text.IndexOf("(yes/no",StringComparison.OrdinalIgnoreCase)>=0)return Kind.Confirm;
            if(login==null||String.IsNullOrEmpty(login.secret))return Kind.Ask;
            if(login.UsesKey){
                Func<string,string> plain=p=>p.Replace('\\','/').Replace("//","/");
                if(String.Equals(text,"Enter passphrase:",StringComparison.OrdinalIgnoreCase))return Kind.Secret;
                return text.StartsWith("Enter passphrase",StringComparison.OrdinalIgnoreCase)&&plain(text).IndexOf(plain(login.keyPath),StringComparison.OrdinalIgnoreCase)>=0?Kind.Secret:Kind.Ask;
            }
            string who=Regex.Escape(login.username+"@"+login.host);
            return Regex.IsMatch(text,@"\A(?:"+who+@"'s password:|\("+who+@"\) ?Password:|Password:)\z",RegexOptions.IgnoreCase)?Kind.Secret:Kind.Ask;
        }
        static void Answer(string value){
            var bytes=Encoding.UTF8.GetBytes(value+"\n");
            using(var output=Console.OpenStandardOutput())output.Write(bytes,0,bytes.Length);
        }
        internal static int Run(string name,string prompt){
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
            try{L.Set(AppSettings.Load(PortableState.PreferencesPath).language);}catch{}
            SshLogin login=null;
            try{login=SshStore.Load(PortableState.DirectoryPath).Get(name);}catch{}
            string style=Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT")??"";
            if(style=="none"){return 0;}
            if(style=="confirm")return Dialog(prompt,false,true)!=null?0:1;
            var kind=Classify(prompt,login);
            if(kind==Kind.Secret){
                try{Answer(SshSecret.Unprotect(login.secret));return 0;}catch{kind=Kind.Ask;}
            }
            if(kind==Kind.Confirm){Answer(Dialog(L.Text("请核对这台服务器的指纹，确认后才会继续连接：")+"\r\n\r\n"+prompt,false,true)!=null?"yes":"no");return 0;}
            string typed=Dialog(prompt,true,false);
            if(typed==null)return 1;
            Answer(typed);return 0;
        }
        // Returns null when dismissed. The window is always on top: it answers a terminal the user is looking at.
        static string Dialog(string message,bool input,bool yesNo){
            var colors=Palette.Create(AppSettings.SystemDark(false,false));
            using(var form=new Form{Text="CMCP · SSH",FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false,StartPosition=FormStartPosition.CenterScreen,TopMost=true,ClientSize=new Size(520,200),BackColor=colors.Surface,ForeColor=colors.Text,Font=new Font("Microsoft YaHei UI",10F)}){
                var label=new Label{Text=message,Bounds=new Rectangle(18,14,484,input?96:130),BackColor=colors.Surface,ForeColor=colors.Text};
                var box=new TextBox{Bounds=new Rectangle(18,112,484,28),UseSystemPasswordChar=true,Visible=input};
                var ok=new Button{Text=L.Text(yesNo?"信任并继续":"确定"),Bounds=new Rectangle(280,154,110,32),DialogResult=DialogResult.OK,UseVisualStyleBackColor=true,ForeColor=SystemColors.ControlText};
                var cancel=new Button{Text=L.Text("取消"),Bounds=new Rectangle(396,154,106,32),DialogResult=DialogResult.Cancel,UseVisualStyleBackColor=true,ForeColor=SystemColors.ControlText};
                form.Controls.AddRange(new Control[]{label,box,ok,cancel});form.AcceptButton=yesNo?null:ok;form.CancelButton=cancel;
                form.Shown+=delegate{form.Activate();if(input)box.Focus();else cancel.Focus();};
                return form.ShowDialog()==DialogResult.OK?box.Text:null;
            }
        }
    }
}
