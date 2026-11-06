using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace CMCP {
    // The background SSH channel of a device, as app/ssh-terminal.mjs publishes it.
    // The worker rewrites its record every second and removes it when it stops.
    internal static class SshWorkers {
        const int FreshSeconds=10;
        internal static string Key(string directory,string id){
            using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory)+"\0"+id))).Replace("-","").ToLowerInvariant();
        }
        internal static string RecordFile(string directory,string id){return Path.Combine(directory,"ssh-mcp",Key(directory,id)+".json");}
        static Dictionary<string,object> Read(string file){
            if(new FileInfo(file).Length>8192)throw new InvalidDataException();
            var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
            if(data==null)throw new InvalidDataException();
            return data;
        }
        static bool Alive(long pid){
            try{using(Process.GetProcessById((int)pid))return true;}catch(ArgumentException){return false;}
        }
        // Empty when nothing runs. Null when the record could not be read this time,
        // which happens while the worker replaces it: the caller keeps what it last knew.
        internal static string State(string directory,string id){
            try{
                string file=RecordFile(directory,id);
                if(!File.Exists(file))return "";
                var record=Read(file);
                long at=Convert.ToInt64(record["at"]),pid=Convert.ToInt64(record["pid"]);
                long now=(DateTime.UtcNow.Ticks-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).Ticks)/TimeSpan.TicksPerMillisecond;
                if(now-at>FreshSeconds*1000||!Alive(pid))return "";
                return record["state"] as string??"";
            }catch{return null;}
        }
        // Asks the worker to stop, the same way ensureSshWorker does. Only the terminal windows stay.
        internal static bool Stop(string directory,string id,int timeout=2000){
            try{
                string key=Key(directory,id),token=Read(RecordFile(directory,id))["token"] as string;
                if(String.IsNullOrEmpty(token))return false;
                using(var pipe=new NamedPipeClientStream(".","cmcp-ssh-"+key,PipeDirection.InOut)){
                    pipe.Connect(timeout);
                    var request=Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new Dictionary<string,string>{{"token",token},{"action","stop"}})+"\n");
                    pipe.Write(request,0,request.Length);pipe.Flush();
                    for(int b=pipe.ReadByte();b>=0&&b!='\n';b=pipe.ReadByte()){}
                }
                return true;
            }catch{return false;}
        }
    }
    // A terminal opened while "close the terminal on disconnect" is on records the PID of its
    // shell here. Ending the ssh inside it lets the shell finish, so its window or tab closes.
    internal static class SshSessions {
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
        struct Entry {public uint dwSize,cntUsage,th32ProcessID;public IntPtr th32DefaultHeapID;public uint th32ModuleID,cntThreads,th32ParentProcessID;public int pcPriClassBase;public uint dwFlags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string szExeFile;}
        [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
        [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
        [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr process,uint code);
        internal static string Folder(string directory,string id){return Path.Combine(directory,"ssh-sessions",SshWorkers.Key(directory,id));}
        static List<KeyValuePair<int,string>> Children(int parent){
            var found=new List<KeyValuePair<int,string>>();
            IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==IntPtr.Zero||snapshot==new IntPtr(-1))return found;
            try{
                var entry=new Entry{dwSize=(uint)Marshal.SizeOf(typeof(Entry))};
                for(bool more=Process32FirstW(snapshot,ref entry);more;more=Process32NextW(snapshot,ref entry))
                    if(entry.th32ParentProcessID==parent)found.Add(new KeyValuePair<int,string>((int)entry.th32ProcessID,entry.szExeFile));
            }finally{CloseHandle(snapshot);}
            return found;
        }
        // Ends the ssh of every recorded terminal of this device and returns how many ended.
        internal static int Close(string directory,string id){
            string folder=Folder(directory,id);int closed=0;
            if(!Directory.Exists(folder))return 0;
            foreach(string file in Directory.GetFiles(folder,"*.pid")){
                int pid;bool alive=false;
                if(!Int32.TryParse(Path.GetFileNameWithoutExtension(file),out pid)||pid<=0){try{File.Delete(file);}catch{}continue;}
                // A PID that a later program took over is not this terminal: its shell wrote the record after it started.
                try{using(var shell=Process.GetProcessById(pid))alive=shell.StartTime<=File.GetLastWriteTime(file).AddSeconds(2);}catch{}
                if(!alive){try{File.Delete(file);}catch{}continue;}
                foreach(var child in Children(pid)){
                    if(!String.Equals(child.Value,"ssh.exe",StringComparison.OrdinalIgnoreCase))continue;
                    IntPtr handle=OpenProcess(1,false,child.Key);if(handle==IntPtr.Zero)continue;
                    // Exit code 0, so the shell treats it as a normal end and closes without waiting for a key.
                    try{if(TerminateProcess(handle,0))closed++;}finally{CloseHandle(handle);}
                }
            }
            return closed;
        }
    }
}
