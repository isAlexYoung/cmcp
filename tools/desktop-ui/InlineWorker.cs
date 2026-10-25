using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace CMCP {
    // Each action owns only its PowerShell observer. The shared Node backend is
    // never killed by this class; stop uses the existing per-target switch.
    internal sealed class InlineWorker : IDisposable {
        internal readonly Process Process;
        readonly Queue<string> events = new Queue<string>();
        internal InlineWorker(string kit,string action,string name,string url,string password,bool autoLogin=false,string stateDirectory=null) {
            bool save=action=="add"||action=="edit";
            string file=save?"manager-save.ps1":Actions.Script(action);
            if(!File.Exists(Path.Combine(kit,file)))throw new FileNotFoundException(file);
            if(!save&&String.IsNullOrWhiteSpace(name))throw new ArgumentException("Select a target");
            string command="& "+Actions.Quote(Path.Combine(kit,file));
            if(!save){command+=" -TargetName "+Actions.Quote(name)+" -ManagerMode";if(action=="connect"||action=="stop")command+=" -RequestTime "+ControlRequestOrder.Next(stateDirectory??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClaudeLocalMcp")).ToString(System.Globalization.CultureInfo.InvariantCulture);}
            var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) {
                UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=kit,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true,StandardOutputEncoding=new UTF8Encoding(false)
            };
            Process=new Process{StartInfo=info};
            Process.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs e){
                if(e.Data==null||e.Data.Length>4096)return;
                lock(events){if(events.Count==64)events.Dequeue();events.Enqueue(e.Data);}
            };
            // Do not forward raw stderr (which could contain server data).
            Process.ErrorDataReceived+=delegate{};
            try {
                Process.Start();Process.BeginOutputReadLine();Process.BeginErrorReadLine();
                if(save){var text=new JavaScriptSerializer().Serialize(new{action=action,name=name,url=url,password=password,autoLogin=autoLogin});using(var input=new StreamWriter(Process.StandardInput.BaseStream,new UTF8Encoding(false))){input.WriteLine(text);}}
                else Process.StandardInput.Close();
            }catch{Process.Dispose();throw;}
        }
        internal IList<IDictionary<string,object>> Drain(){
            var result=new List<IDictionary<string,object>>();
            lock(events)while(events.Count>0){try{
                var data=LocalState.Obj(new JavaScriptSerializer{MaxJsonLength=4096,RecursionLimit=8}.DeserializeObject(events.Dequeue()));
                string kind=LocalState.Text(LocalState.Get(data,"kind")),message=LocalState.Text(LocalState.Get(data,"message"));
                if(Convert.ToString(LocalState.Get(data,"schema"))!="1"||message.Length>512||message.IndexOf('\0')>=0)continue;
                if(kind=="progress"||kind=="error"||kind=="complete"||kind=="saved")result.Add(data);
            }catch{}}
            return result;
        }
        public void Dispose(){Process.Dispose();}
    }

    internal static class ControlRequestOrder {
        internal static long Next(string directory) { return Next(directory,DateTime.UtcNow.Ticks); }
        internal static long Next(string directory,long clock) {
            string key;
            using(var hash=System.Security.Cryptography.SHA256.Create())key=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(directory.ToLowerInvariant()))).Replace("-","").Substring(0,20);
            using(var mutex=new System.Threading.Mutex(false,"Local\\ClaudeMcpTargetControls-"+key)) {
                bool locked=false;
                try {
                    try{locked=mutex.WaitOne(10000);}catch(System.Threading.AbandonedMutexException){locked=true;}
                    if(!locked)throw new IOException("Connection preferences are busy");
                    Directory.CreateDirectory(directory);
                    string file=Path.Combine(directory,"control-order.txt"),controls=Path.Combine(directory,"target-controls.json");
                    long latest=Math.Max(0,clock);
                    if(File.Exists(file)){if(new FileInfo(file).Length>32)throw new IOException("Invalid connection request order");latest=Math.Max(latest,ReadNumber(File.ReadAllText(file)));}
                    if(File.Exists(controls)) {
                        if(new FileInfo(controls).Length>262144)throw new IOException("Invalid connection preferences");
                        var data=LocalState.Obj(new JavaScriptSerializer{MaxJsonLength=262144}.DeserializeObject(File.ReadAllText(controls)));
                        var targets=LocalState.Get(data,"targets") as object[];
                        if(Convert.ToString(LocalState.Get(data,"schema"))!="1"||targets==null||targets.Length>100)throw new IOException("Invalid connection preferences");
                        foreach(var value in targets){var entry=LocalState.Obj(value);var time=LocalState.Get(entry,"requestTime");if(time!=null)latest=Math.Max(latest,ReadNumber(Convert.ToString(time)));}
                    }
                    long next=checked(latest+1);
                    string temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
                    try {
                        File.WriteAllText(temp,next.ToString(System.Globalization.CultureInfo.InvariantCulture),new UTF8Encoding(false));
                        for(int attempt=0;;attempt++)try{if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);break;}catch(IOException){if(attempt==9)throw;System.Threading.Thread.Sleep(30);}
                    }finally{if(File.Exists(temp))File.Delete(temp);}
                    return next;
                }finally{if(locked)mutex.ReleaseMutex();}
            }
        }
        static long ReadNumber(string value){long number;if(value.Length>32||!Int64.TryParse(value,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out number)||number<0)throw new IOException("Invalid connection request order");return number;}
    }

    internal static class ControlOrderTests {
        internal static void Run(string root,Action<bool,string> check){
            string directory=Path.Combine(root,"order-test");Directory.CreateDirectory(directory);
            string controls=Path.Combine(directory,"target-controls.json"),order=Path.Combine(directory,"control-order.txt");
            try{
                long future=DateTime.UtcNow.AddDays(2).Ticks;
                File.WriteAllText(controls,"{\"schema\":1,\"targets\":[{\"name\":\"A\",\"enabled\":false,\"revision\":\"unchanged\",\"requestTime\":\""+future+"\"}]}");
                string original=File.ReadAllText(controls);
                long first=ControlRequestOrder.Next(directory,10),second=ControlRequestOrder.Next(directory,1);
                check(first>future&&second==first+1,"clock rollback and future legacy stop cannot discard a new GUI request");
                check(File.ReadAllText(controls)==original,"reserving request order never enables targets or changes revisions");
                File.Delete(controls);
                check(ControlRequestOrder.Next(directory,0)==second+1,"request sequence persists across allocator reload and deleted target records");
                var tasks=new System.Threading.Tasks.Task<long>[8];
                for(int i=0;i<tasks.Length;i++)tasks[i]=System.Threading.Tasks.Task.Factory.StartNew(()=>ControlRequestOrder.Next(directory,0));
                System.Threading.Tasks.Task.WaitAll(tasks);
                var values=new System.Collections.Generic.HashSet<long>();foreach(var task in tasks)values.Add(task.Result);
                check(values.Count==8,"concurrent GUI requests reserve distinct durable order numbers");
                long guiOrder=ControlRequestOrder.Next(directory,0);
                string script=". "+Actions.Quote(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"app","common.ps1"))+"; $script:StateDir="+Actions.Quote(directory)+"; New-TargetRequestOrder";
                var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};
                using(var child=Process.Start(info)){
                    if(!child.WaitForExit(10000)){child.Kill();throw new IOException("Ordering fixture timed out");}
                    long scriptOrder=Int64.Parse(child.StandardOutput.ReadToEnd().Trim());
                    check(child.ExitCode==0&&scriptOrder==guiOrder+1&&ControlRequestOrder.Next(directory,0)==scriptOrder+1,"GUI and PowerShell processes share durable ordering after clock rollback");
                }
                File.WriteAllText(order,"invalid");bool rejected=false;try{ControlRequestOrder.Next(directory,0);}catch(IOException){rejected=true;}
                check(rejected&&File.ReadAllText(order)=="invalid","corrupt request sequence fails safely without overwriting it");
                File.WriteAllText(order,Int64.MaxValue.ToString());bool overflow=false;try{ControlRequestOrder.Next(directory,0);}catch(OverflowException){overflow=true;}
                check(overflow,"request sequence overflow fails without wrapping into an older operation");
            }finally{File.Delete(controls);File.Delete(order);Directory.Delete(directory,false);}
        }
    }
}
