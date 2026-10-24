using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace CMCP {
    internal static class BackendRestart {
        // Demo, screenshots and self-tests never enter the live launch path.
        internal static bool Run(string kit,string entry="manager-restart.ps1") {
            try {
                string script=Path.Combine(kit,entry);
                if(!File.Exists(script))return false;
                string command="& "+Actions.Quote(script);
                var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) {
                    UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=kit,RedirectStandardOutput=true,RedirectStandardError=true
                };
                using(var process=new Process{StartInfo=info}) {
                    process.OutputDataReceived+=delegate{};process.ErrorDataReceived+=delegate{};
                    process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();
                    if(!process.WaitForExit(150000)){try{process.Kill();}catch{}return false;}
                    return process.ExitCode==0;
                }
            }catch{return false;}
        }
        internal static void Test(string directory,Action<bool,string> check) {
            string kit=Path.Combine(directory,"restart worker 中文'");Directory.CreateDirectory(kit);
            string proof=Path.Combine(kit,"hidden.txt"),script=Path.Combine(kit,"manager-restart.ps1");
            File.WriteAllText(script,"[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'hidden.txt'),[string](Get-Process -Id $PID).MainWindowHandle);[Console]::Out.Write(('x'*65536));[Console]::Error.Write(('x'*65536));exit 0",new UTF8Encoding(true));
            check(Run(kit)&&File.Exists(proof)&&File.ReadAllText(proof)=="0","real hidden restart worker handles Unicode paths and drains both output pipes");
            File.WriteAllText(script,"exit 7",new UTF8Encoding(true));
            check(!Run(kit),"restart failure returns without a modal dialog");
            File.Delete(script);check(!Run(kit),"missing restart entry fails silently without launching other scripts");
        }
    }
}
