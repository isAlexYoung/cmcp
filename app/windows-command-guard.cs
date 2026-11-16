// A private Windows job owns one MCP command and its descendants, never an arbitrary PID.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class CommandGuard {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long UserTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Startup { public int Size; public IntPtr Reserved,Desktop,Title; public uint X,Y,Width,Height,XChars,YChars,Fill,Flags; public ushort Show,ReservedBytes; public IntPtr ReservedData,Input,Output,Error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct MemoryStatus { public uint Length,Load; public ulong TotalPhysical,AvailablePhysical,TotalPagefile,AvailablePagefile,TotalVirtual,AvailableVirtual,AvailableExtended; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit limits,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint flags);
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MemoryStatus memory);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint SearchPath(string path,string file,string extension,uint size,StringBuilder result,IntPtr part);

    static void Check(bool ok,string stage) { if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),stage); }
    static ulong AvailableCommit() {var memory=new MemoryStatus{Length=(uint)Marshal.SizeOf(typeof(MemoryStatus))};Check(GlobalMemoryStatusEx(ref memory),"read memory budget");return memory.AvailablePagefile;}
    static string Quote(string value) {
        var text=new StringBuilder("\"");int slashes=0;
        foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){text.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}text.Append('\\',slashes).Append(c);slashes=0;}
        return text.Append('\\',slashes*2).Append('"').ToString();
    }
    static string Resolve(string executable){
        if(Path.IsPathRooted(executable)){if(!File.Exists(executable))throw new FileNotFoundException("Executable not found");return executable;}
        var path=new StringBuilder(32768);uint size=SearchPath(null,executable,".exe",32768,path,IntPtr.Zero);
        if(size==0||size>=32768)throw new FileNotFoundException("Executable not found on PATH");return path.ToString();
    }
    static int Main(string[] args) {
        IntPtr job=IntPtr.Zero;var child=new ProcessInfo();
        try {
            SetErrorMode(0x0001|0x0002); // Child failures use stderr, not system error dialogs.
            if(args.Length!=1)throw new ArgumentException("Missing command request");
            var request=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
            int megabytes=Convert.ToInt32(request["memoryMb"]);if(megabytes<64||megabytes>8192)throw new ArgumentException("Invalid memory budget");
            if(AvailableCommit()<768UL*1024*1024)throw new InvalidOperationException("System commit memory is too low to start another command");
            job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"create command job");
            var limits=new ExtendedLimit();limits.Basic.Flags=0x2000|0x200|0x8; // kill on close, aggregate commit, process count
            limits.JobMemory=(UIntPtr)((ulong)megabytes*1024*1024);limits.Basic.ActiveLimit=128;
            Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit))),"apply command memory budget");
            string executable=Resolve((string)request["executable"]);var command=new StringBuilder(Quote(executable));
            bool verbatim=Convert.ToBoolean(request["verbatim"]);
            foreach(object argument in (System.Collections.IEnumerable)request["args"])command.Append(' ').Append(verbatim?(string)argument:Quote((string)argument));
            var startup=new Startup{Size=Marshal.SizeOf(typeof(Startup)),Flags=0x100,Input=GetStdHandle(-10),Output=GetStdHandle(-11),Error=GetStdHandle(-12)};
            foreach(IntPtr handle in new[]{startup.Input,startup.Output,startup.Error})if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1))Check(SetHandleInformation(handle,1,1),"inherit command pipe");
            // No target code can execute until it belongs to the job, closing the spawn/assignment race.
            Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x4,IntPtr.Zero,(string)request["cwd"],ref startup,out child),"start suspended command");
            Check(AssignProcessToJobObject(job,child.Process),"attach command to resource budget");
            int owner=Convert.ToInt32(request["owner"]);long ownerStart=Convert.ToInt64((string)request["ownerStart"]);
            using(var parent=Process.GetProcessById(owner)){
                if(parent.StartTime.ToUniversalTime().Ticks!=ownerStart||parent.HasExited)throw new InvalidOperationException("Command owner exited");
                Check(ResumeThread(child.Thread)!=0xffffffff,"resume bounded command");
                CloseHandle(child.Thread);child.Thread=IntPtr.Zero;
                while(WaitForSingleObject(child.Process,250)==258){
                    if(parent.HasExited){Console.Error.WriteLine("[CMCP resource guard] command owner exited; stopping this job");TerminateJobObject(job,125);return 125;}
                    if(AvailableCommit()<256UL*1024*1024){Console.Error.WriteLine("[CMCP resource guard] system commit memory is nearly exhausted; stopping this job");TerminateJobObject(job,125);return 125;}
                }
            }
            uint code;Check(GetExitCodeProcess(child.Process,out code),"read command exit");
            if(code!=0)Console.Error.WriteLine("[CMCP resource guard] command exited with code "+code+"; job memory cap "+megabytes+" MiB");
            return unchecked((int)code);
        } catch(Exception error){
            Console.Error.WriteLine("[CMCP resource guard] "+error.Message);
            if(child.Process!=IntPtr.Zero)TerminateProcess(child.Process,126);
            return 126;
        } finally {
            if(job!=IntPtr.Zero)CloseHandle(job); // Only members of this command's job are terminated.
            if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);
            if(child.Process!=IntPtr.Zero)CloseHandle(child.Process);
        }
    }
}
