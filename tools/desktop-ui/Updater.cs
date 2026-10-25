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
        readonly Action<UpdateProgress> progress;
        readonly Action exit;
        DateTime checkedAt=DateTime.MinValue;
        Process child;
        bool busy,disposed;
        internal string Status="检查更新";
        internal UpdateProgress Progress;
        internal bool Installing {get{return busy&&installing;}}
        bool installing;
        internal UpdateController(string install,string data,bool test,Action<string> notify,Action close,Action<UpdateProgress> changed=null){root=install;state=data;isolated=test;report=notify;exit=close;progress=changed;}
        void Notify(string value){Status=value;report(value);}
        void ShowProgress(UpdateProgress value){Progress=value;if(progress!=null)progress(value);if(value!=null)Notify(value.Title);}
        internal void Check(bool force){if(busy||disposed)return;if(isolated){Notify("已是最新版");return;}if(!force&&DateTime.UtcNow-checkedAt<TimeSpan.FromMinutes(15)){report(Status);return;}Run("check");}
        internal void Install(){if(busy||disposed)return;if(isolated){Notify("Preview: updates are disabled.");return;}if(File.Exists(Path.Combine(root,".git"))||Directory.Exists(Path.Combine(root,".git"))){Notify("源码目录不会自动覆盖，请从发布页下载便携包。");return;}Run("prepare");}
        void Run(string action){busy=true;installing=action=="prepare";if(installing)ShowProgress(new UpdateProgress{Stage="installed"});else Notify("正在检查更新…");
            var worker=new BackgroundWorker{WorkerReportsProgress=true};
            worker.ProgressChanged+=delegate(object sender,ProgressChangedEventArgs e){if(!disposed)ShowProgress((UpdateProgress)e.UserState);};
            worker.DoWork+=delegate(object sender,DoWorkEventArgs e){
                string script=Path.Combine(root,"app","update.ps1");
                var command="& "+Actions.Quote(script)+" -Action "+Actions.Quote(action)+" -InstallRoot "+Actions.Quote(root)+" -StateDirectory "+Actions.Quote(state)+" -ManagerPid "+Process.GetCurrentProcess().Id;
                var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=state};
                Directory.CreateDirectory(state);using(var process=new Process{StartInfo=info}){lock(this){if(disposed)return;child=process;process.Start();}
                    Dictionary<string,object> result=null;bool invalid=false;object sync=new object();
                    process.OutputDataReceived+=delegate(object s,DataReceivedEventArgs line){if(String.IsNullOrWhiteSpace(line.Data))return;try{
                        if(line.Data.Length>8192)throw new InvalidDataException();
                        var packet=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line.Data);
                        var value=UpdateProgress.Read(packet);
                        if(value!=null){if(installing)worker.ReportProgress(0,value);}
                        else {string status=Convert.ToString(LocalState.Get(packet,"status"));if(status!="current"&&status!="available"&&status!="prepared"&&status!="failed")throw new InvalidDataException();lock(sync){if(result!=null)invalid=true;result=packet;}}
                    }catch{lock(sync)invalid=true;}};
                    process.ErrorDataReceived+=delegate{};process.BeginOutputReadLine();process.BeginErrorReadLine();
                    try{if(!process.WaitForExit(15*60*1000)){try{process.Kill();}catch{}throw new TimeoutException();}process.WaitForExit();lock(sync){if(invalid||result==null||(process.ExitCode!=0&&Convert.ToString(LocalState.Get(result,"status"))!="failed"))throw new InvalidDataException();e.Result=result;}}
                    finally{lock(this){child=null;}}
                }
            };
            worker.RunWorkerCompleted+=delegate(object sender,RunWorkerCompletedEventArgs e){worker.Dispose();busy=false;if(disposed)return;
                if(e.Error!=null||e.Result==null){if(action=="check")Notify("检查失败，请重试");else ShowProgress(new UpdateProgress{Stage="failed",Code=e.Error is TimeoutException?"timeout":"prepare"});return;}
                var data=(Dictionary<string,object>)e.Result;string result=Convert.ToString(LocalState.Get(data,"status"));
                if(result=="failed"){if(action=="check")Notify("检查失败，请重试");else ShowProgress(new UpdateProgress{Stage="failed",Code=Convert.ToString(LocalState.Get(data,"code"))});return;}
                checkedAt=DateTime.UtcNow;
                if(result=="current"){ShowProgress(null);Notify("已是最新版");return;}if(result=="available"){Notify("有可用更新");return;}
                if(result!="prepared"){ShowProgress(new UpdateProgress{Stage="failed"});return;}
                try{
                    string transaction=Convert.ToString(LocalState.Get(data,"transaction"));Guid id;if(!Guid.TryParseExact(transaction,"N",out id))throw new IOException();
                    string path=PortableState.TransactionPath(root,transaction),helper=Path.Combine(path,"update-apply.ps1");
                    string command="& "+Actions.Quote(helper)+" -Transaction "+Actions.Quote(transaction);
                    Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=path}).Dispose();
                    ShowProgress(new UpdateProgress{Stage="restart",Received=1,Total=1});exit();
                }catch{ShowProgress(new UpdateProgress{Stage="failed"});}
            };worker.RunWorkerAsync();
        }
        public void Dispose(){lock(this){disposed=true;if(child!=null)try{if(!child.HasExited)child.Kill();}catch{}child=null;}}
        internal static void Acknowledge(string transaction,bool healthy){
            Guid id;if(!healthy||!Guid.TryParseExact(transaction,"N",out id))return;
            foreach(string state in new[]{PortableState.TransactionPath(AppDomain.CurrentDomain.BaseDirectory,transaction),Path.Combine(PortableState.Legacy,"updates",transaction)})try{string request=Path.Combine(state,"request.json");
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(request));
                if(!String.Equals(Path.GetFullPath(Convert.ToString(data["installRoot"])).TrimEnd('\\'),Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)||Convert.ToString(data["version"])!=Application.ProductVersion.Substring(0,Application.ProductVersion.LastIndexOf('.')))continue;
                File.WriteAllText(Path.Combine(state,"ready.json"),new JavaScriptSerializer().Serialize(new{token=data["token"],pid=Process.GetCurrentProcess().Id}),new UTF8Encoding(false));
                if(String.Equals(Path.GetDirectoryName(state),Path.Combine(PortableState.Legacy,"updates"),StringComparison.OrdinalIgnoreCase)){
                    string script=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"app","update-finalize.ps1");
                    string command="& "+Actions.Quote(script)+" -Transaction "+Actions.Quote(transaction);
                    Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=AppDomain.CurrentDomain.BaseDirectory}).Dispose();
                }
                return;
            }catch{}
        }
    }
}
