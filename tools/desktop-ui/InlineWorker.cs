using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace ClaudeMcp {
    // Each action owns only its PowerShell observer. The shared Node backend is
    // never killed by this class; stop uses the existing per-target switch.
    internal sealed class InlineWorker : IDisposable {
        internal readonly Process Process;
        readonly Queue<string> events = new Queue<string>();
        internal InlineWorker(string kit,string action,string name,string url,string password,bool autoLogin=false) {
            bool save=action=="add"||action=="edit";
            string file=save?"manager-save.ps1":Actions.Script(action);
            if(!File.Exists(Path.Combine(kit,file)))throw new FileNotFoundException(file);
            if(!save&&String.IsNullOrWhiteSpace(name))throw new ArgumentException("Select a target");
            string command="& "+Actions.Quote(Path.Combine(kit,file));
            if(!save){command+=" -TargetName "+Actions.Quote(name)+" -ManagerMode";if(action=="connect"||action=="stop")command+=" -RequestTime "+DateTime.UtcNow.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);}
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
}
