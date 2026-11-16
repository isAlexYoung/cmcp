using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace CMCP {
    internal static class BackendRestart {
        // Demo, screenshots and self-tests never enter the live launch path.
        internal static void Log(string kit,string entry,string stage){
            try{string state=Environment.GetEnvironmentVariable("CMCP_STATE_DIR");if(String.IsNullOrEmpty(state))state=Path.Combine(Path.GetDirectoryName(kit),"user");Directory.CreateDirectory(state);File.AppendAllText(Path.Combine(state,"manager-lifecycle.log"),DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff")+" "+entry+" "+stage+Environment.NewLine,new UTF8Encoding(false));}catch{}
        }
        internal static bool Run(string kit,string entry="manager-restart.ps1",bool forceRestart=false,int timeoutMilliseconds=150000) {
            try {
                string script=Path.Combine(kit,entry);
                if(!File.Exists(script))return false;
                string command="& "+Actions.Quote(script)+(forceRestart?" -ForceRestart":"");
                var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) {
                    UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=kit,RedirectStandardOutput=true,RedirectStandardError=true
                };
                using(var process=new Process{StartInfo=info}) {
                    process.OutputDataReceived+=delegate{};process.ErrorDataReceived+=delegate{};
                    process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();
                    Log(kit,entry,"started pid="+process.Id);
                    int deadline=entry=="manager-exit.ps1"?Math.Min(timeoutMilliseconds,60000):timeoutMilliseconds;
                    if(!process.WaitForExit(deadline)){try{process.Kill();process.WaitForExit(1000);}catch{}Log(kit,entry,"timed out after "+deadline+"ms; only this worker was terminated");return false;}
                    Log(kit,entry,"finished exit="+process.ExitCode);
                    return process.ExitCode==0;
                }
            }catch{Log(kit,entry,"worker failed");return false;}
        }
        internal static void Test(string directory,Action<bool,string> check) {
            string kit=Path.Combine(directory,"restart worker 中文'");Directory.CreateDirectory(kit);
            string proof=Path.Combine(kit,"hidden.txt"),script=Path.Combine(kit,"manager-restart.ps1");
            File.WriteAllText(script,"[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'hidden.txt'),[string](Get-Process -Id $PID).MainWindowHandle);[Console]::Out.Write(('x'*65536));[Console]::Error.Write(('x'*65536));exit 0",new UTF8Encoding(true));
            check(Run(kit)&&File.Exists(proof)&&File.ReadAllText(proof)=="0","real hidden restart worker handles Unicode paths and drains both output pipes");
            File.WriteAllText(script,"exit 7",new UTF8Encoding(true));
            check(!Run(kit),"restart failure returns without a modal dialog");
            File.WriteAllText(script,"Start-Sleep -Seconds 60",new UTF8Encoding(true));
            var timer=Stopwatch.StartNew();check(!Run(kit,"manager-restart.ps1",false,500)&&timer.ElapsedMilliseconds<4000,"a wedged lifecycle worker has a bounded wait and returns control");
            File.Delete(script);check(!Run(kit),"missing restart entry fails silently without launching other scripts");
        }
    }
}
