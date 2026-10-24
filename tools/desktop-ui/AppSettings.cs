using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace ClaudeMcp {
    internal sealed class AppSettings {
        public string language="zh-CN",theme="";
        public bool autoStart,closeToTray=true;
        internal bool ReadError;
        Dictionary<string,object> extra=new Dictionary<string,object>();
        internal static string PathFor(string state){return Path.Combine(state,"application-preferences.json");}
        internal AppSettings Copy(){return new AppSettings{language=language,theme=theme,autoStart=autoStart,closeToTray=closeToTray,ReadError=ReadError,extra=new Dictionary<string,object>(extra)};}
        internal static AppSettings Load(string state,bool defaultStartup=false){
            var result=new AppSettings{autoStart=defaultStartup};string file=PathFor(state);
            try{
                if(!File.Exists(file))return result;
                if(new FileInfo(file).Length>32768)throw new IOException();
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
                object value;if(data==null||!data.TryGetValue("schema",out value)||Convert.ToString(value)!="1")throw new IOException();
                if(data.TryGetValue("language",out value)){if(!(value is string)||((string)value!="zh-CN"&&(string)value!="en"))throw new IOException();result.language=(string)value;}
                if(data.TryGetValue("theme",out value)){if(!(value is string)||((string)value!=""&&(string)value!="light"&&(string)value!="dark"&&(string)value!="system"))throw new IOException();result.theme=(string)value;}
                if(data.TryGetValue("autoStart",out value)){if(!(value is bool))throw new IOException();result.autoStart=(bool)value;}
                if(data.TryGetValue("closeToTray",out value)&&!(value is bool))throw new IOException();
                // Both old choices kept connections alive. Migrate them to tray;
                // only an explicit new closeAction may select disconnect-and-exit.
                if(data.TryGetValue("closeAction",out value)){if(!(value is string)||((string)value!="tray"&&(string)value!="exit"))throw new IOException();result.closeToTray=(string)value=="tray";}
                result.extra=data;return result;
            }catch{result.ReadError=true;return result;}
        }
        internal void Save(string state){
            if(ReadError)throw new IOException("设置文件损坏，未覆盖原文件。");
            Directory.CreateDirectory(state);string file=PathFor(state),temp=file+"."+Guid.NewGuid().ToString("N")+".tmp";
            using(var mutex=new Mutex(false,"Local\\CMCP-AppSettings-"+DesktopKey(state))){bool owned=false;try{
                try{owned=mutex.WaitOne(5000);}catch(AbandonedMutexException){owned=true;}if(!owned)throw new IOException("设置正在保存。");
                var current=Load(state);if(current.ReadError)throw new IOException("设置文件损坏，未覆盖原文件。");
                var data=current.extra;data["schema"]=1;data["language"]=language;data["theme"]=theme;data["autoStart"]=autoStart;data["closeToTray"]=closeToTray;data["closeAction"]=closeToTray?"tray":"exit";
                string json=new JavaScriptSerializer().Serialize(data);if(Encoding.UTF8.GetByteCount(json)>32768)throw new IOException("设置文件过大。");
                File.WriteAllText(temp,json,new UTF8Encoding(false));
                if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);
            }finally{if(File.Exists(temp))File.Delete(temp);if(owned)mutex.ReleaseMutex();}}
        }
        static string DesktopKey(string state){using(var hash=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(state).ToLowerInvariant()))).Replace("-","").Substring(0,20);}
        internal bool IsDark(bool previous){if(theme=="dark")return true;if(theme=="light")return false;if(theme!="system")return previous;try{using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))return Convert.ToInt32(key==null?1:key.GetValue("AppsUseLightTheme",1))==0;}catch{return previous;}}
    }
    internal static class StartupRegistration {
        internal const string RunPath=@"Software\Microsoft\Windows\CurrentVersion\Run",Name="CMCPManager",LegacyName="ClaudeCloudPcLink";
        internal static bool Enabled(string keyPath=RunPath){using(var key=Registry.CurrentUser.OpenSubKey(keyPath))return key!=null&&(key.GetValue(Name)!=null||key.GetValue(LegacyName)!=null);}
        internal static void Set(string executable,bool enabled,string keyPath=RunPath){
            string exe=Path.GetFullPath(executable);if(!File.Exists(exe))throw new IOException("程序路径不存在。");
            using(var key=Registry.CurrentUser.CreateSubKey(keyPath)){
                string existing=key.GetValue(Name) as string;
                if(existing!=null&&!existing.EndsWith("\\Claude-MCP.exe\" --startup",StringComparison.OrdinalIgnoreCase)&&existing!="\""+exe+"\" --startup")throw new IOException("开机启动项不属于 CMCP，未覆盖。");
                string legacy=key.GetValue(LegacyName) as string;
                try{
                if(enabled)key.SetValue(Name,"\""+exe+"\" --startup",RegistryValueKind.String);else key.DeleteValue(Name,false);
                if(legacy!=null&&legacy.IndexOf("run-service.ps1",StringComparison.OrdinalIgnoreCase)>=0)key.DeleteValue(LegacyName,false);
            if(keyPath==RunPath){
                string startup=Environment.GetFolderPath(Environment.SpecialFolder.Startup),link=Path.Combine(startup,"Claude 云电脑连接.lnk");
                if(File.Exists(link)){
                    object shell=null,shortcut=null;try{
                        var type=Type.GetTypeFromProgID("WScript.Shell");shell=Activator.CreateInstance(type);shortcut=type.InvokeMember("CreateShortcut",System.Reflection.BindingFlags.InvokeMethod,null,shell,new object[]{link});
                        string arguments=Convert.ToString(shortcut.GetType().InvokeMember("Arguments",System.Reflection.BindingFlags.GetProperty,null,shortcut,null));
                        if(arguments.IndexOf("run-service.ps1",StringComparison.OrdinalIgnoreCase)>=0)File.Delete(link);
                    }finally{if(shortcut!=null)System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);if(shell!=null)System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);}
                }
            }
                }catch{
                    if(existing==null)key.DeleteValue(Name,false);else key.SetValue(Name,existing,RegistryValueKind.String);
                    if(legacy!=null)key.SetValue(LegacyName,legacy,RegistryValueKind.String);throw;
                }
            }
        }
    }
}
