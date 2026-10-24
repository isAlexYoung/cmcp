using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

namespace CMCP {
    internal static class ManagerSignal {
        [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")]static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
        internal static readonly int Message=(int)RegisterWindowMessage("CMCP.RestoreManager."+Environment.UserName);
        internal static void Restore(){PostMessage(new IntPtr(0xffff),(uint)Message,IntPtr.Zero,IntPtr.Zero);}
    }
    internal sealed class UpdateController : IDisposable {
        internal const string ReleaseUrl="https://github.com/isAlexYoung/cmcp/releases/latest";
        readonly string root,state;
        readonly bool isolated;
        readonly Action<string> report;
        readonly Action exit;
        DateTime checkedAt=DateTime.MinValue;
        Process child;
        bool busy,disposed;
        internal string Status="检查更新";
        internal bool Installing {get{return busy&&installing;}}
        bool installing;
        internal UpdateController(string install,string data,bool test,Action<string> notify,Action close){root=install;state=data;isolated=test;report=notify;exit=close;}
        void Notify(string value){Status=value;report(value);}
        internal void Check(bool force){if(busy||disposed)return;if(isolated){Notify("已是最新版");return;}if(!force&&DateTime.UtcNow-checkedAt<TimeSpan.FromMinutes(15)){report(Status);return;}Run("check");}
        internal void Install(){if(busy||disposed)return;if(isolated){Notify("Preview: updates are disabled.");return;}if(File.Exists(Path.Combine(root,".git"))||Directory.Exists(Path.Combine(root,".git"))){Notify("源码目录不会自动覆盖，请从发布页下载便携包。");return;}Run("prepare");}
        void Run(string action){busy=true;installing=action=="prepare";Notify(action=="check"?"正在检查更新…":"正在下载并校验更新…");
            var worker=new BackgroundWorker();worker.DoWork+=delegate(object sender,DoWorkEventArgs e){
                string script=Path.Combine(root,"app","update.ps1");
                var command="& "+Actions.Quote(script)+" -Action "+Actions.Quote(action)+" -InstallRoot "+Actions.Quote(root)+" -StateDirectory "+Actions.Quote(state)+" -ManagerPid "+Process.GetCurrentProcess().Id;
                var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=state};
                Directory.CreateDirectory(state);using(var process=new Process{StartInfo=info}){lock(this){if(disposed)return;child=process;process.Start();}
                    var output=new StringBuilder();process.OutputDataReceived+=delegate(object s,DataReceivedEventArgs line){if(line.Data!=null)lock(output){if(output.Length<65536)output.AppendLine(line.Data);}};process.ErrorDataReceived+=delegate{};
                    process.BeginOutputReadLine();process.BeginErrorReadLine();if(!process.WaitForExit(15*60*1000)){try{process.Kill();}catch{}throw new IOException();}process.WaitForExit();lock(this){child=null;}if(process.ExitCode!=0)throw new IOException();e.Result=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(output.ToString());
                }
            };
            worker.RunWorkerCompleted+=delegate(object sender,RunWorkerCompletedEventArgs e){worker.Dispose();busy=false;if(disposed)return;
                if(e.Error!=null||e.Result==null){Notify(action=="check"?"检查失败，请重试":"更新未完成，请查看本机日志。");return;}
                var data=(Dictionary<string,object>)e.Result;string result=Convert.ToString(LocalState.Get(data,"status"));
                checkedAt=DateTime.UtcNow;
                if(result=="current"){Notify("已是最新版");return;}if(result=="available"){Notify("有可用更新");return;}
                if(result!="prepared"){Notify("更新未完成，请查看本机日志。");return;}
                try{
                    string transaction=Convert.ToString(LocalState.Get(data,"transaction"));Guid id;if(!Guid.TryParseExact(transaction,"N",out id))throw new IOException();
                    string path=Path.Combine(state,"updates",transaction),helper=Path.Combine(path,"update-apply.ps1");
                    string command="& "+Actions.Quote(helper)+" -Transaction "+Actions.Quote(transaction);
                    Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=path}).Dispose();
                    Notify("更新已准备，正在重新启动…");exit();
                }catch{Notify("更新未完成，请查看本机日志。");}
            };worker.RunWorkerAsync();
        }
        public void Dispose(){lock(this){disposed=true;if(child!=null)try{if(!child.HasExited)child.Kill();}catch{}child=null;}}
        internal static void Acknowledge(string transaction,bool healthy){
            Guid id;if(!healthy||!Guid.TryParseExact(transaction,"N",out id))return;
            try{string state=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClaudeLocalMcp","updates",transaction),request=Path.Combine(state,"request.json");
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(request));
                if(!String.Equals(Path.GetFullPath(Convert.ToString(data["installRoot"])).TrimEnd('\\'),Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)||Convert.ToString(data["version"])!=Application.ProductVersion.Substring(0,Application.ProductVersion.LastIndexOf('.')))return;
                File.WriteAllText(Path.Combine(state,"ready.json"),new JavaScriptSerializer().Serialize(new{token=data["token"],pid=Process.GetCurrentProcess().Id}),new UTF8Encoding(false));
            }catch{}
        }
    }
}
