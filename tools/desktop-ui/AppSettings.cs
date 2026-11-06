using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace CMCP {
    internal sealed class AppSettings {
        public string language="zh-CN",theme="system",terminal="",browser="";
        public bool autoStart,closeToTray=true,closeWeb,closeTerminal;
        internal bool ReadError;
        Dictionary<string,object> extra=new Dictionary<string,object>();
        internal static string PathFor(string state){return Path.Combine(state,"application-preferences.json");}
        internal AppSettings Copy(){return new AppSettings{language=language,theme=theme,terminal=terminal,browser=browser,autoStart=autoStart,closeToTray=closeToTray,closeWeb=closeWeb,closeTerminal=closeTerminal,ReadError=ReadError,extra=new Dictionary<string,object>(extra)};}
        internal static AppSettings Load(string state,bool defaultStartup=false){
            var result=new AppSettings{autoStart=defaultStartup};string file=PathFor(state);
            try{
                if(!File.Exists(file))return result;
                if(new FileInfo(file).Length>32768)throw new IOException();
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
                object value;if(data==null||!data.TryGetValue("schema",out value)||Convert.ToString(value)!="1")throw new IOException();
                if(data.TryGetValue("language",out value)){if(!(value is string)||((string)value!="zh-CN"&&(string)value!="en"))throw new IOException();result.language=(string)value;}
                if(data.TryGetValue("theme",out value)){if(!(value is string)||((string)value!=""&&(string)value!="light"&&(string)value!="dark"&&(string)value!="system"))throw new IOException();result.theme=(string)value==""?"system":(string)value;}
                if(data.TryGetValue("terminal",out value)){if(!(value is string))throw new IOException();result.terminal=(string)value;}
                if(data.TryGetValue("autoStart",out value)){if(!(value is bool))throw new IOException();result.autoStart=(bool)value;}
                // A browser that is not offered any more falls back to the system default.
                if(data.TryGetValue("browser",out value)){if(!(value is string))throw new IOException();result.browser=Browsers.Ids.Contains((string)value)?(string)value:"";}
                if(data.TryGetValue("closeWeb",out value)){if(!(value is bool))throw new IOException();result.closeWeb=(bool)value;}
                if(data.TryGetValue("closeTerminal",out value)){if(!(value is bool))throw new IOException();result.closeTerminal=(bool)value;}
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
                var data=current.extra;data["schema"]=1;data["language"]=language;data["theme"]=theme;data["terminal"]=terminal;data["browser"]=browser;data["closeWeb"]=closeWeb;data["closeTerminal"]=closeTerminal;data["autoStart"]=autoStart;data["closeToTray"]=closeToTray;data["closeAction"]=closeToTray?"tray":"exit";
                string json=new JavaScriptSerializer().Serialize(data);if(Encoding.UTF8.GetByteCount(json)>32768)throw new IOException("设置文件过大。");
                File.WriteAllText(temp,json,new UTF8Encoding(false));
                if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);
            }finally{if(File.Exists(temp))File.Delete(temp);if(owned)mutex.ReleaseMutex();}}
        }
        static string DesktopKey(string state){using(var hash=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(state).ToLowerInvariant()))).Replace("-","").Substring(0,20);}
        internal bool IsDark(bool previous){if(theme=="dark")return true;if(theme=="light")return false;return SystemDark(false,previous);}
        internal static bool SystemDark(bool tray,bool fallback){try{using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))return Convert.ToInt32(key==null?1:key.GetValue(tray?"SystemUsesLightTheme":"AppsUseLightTheme",1))==0;}catch{return fallback;}}
    }
    internal sealed class BrowserChoice {internal string Id,Label,Path;}
    // A page CMCP may close later opens in the chosen browser with a profile of its own:
    // that window is then a process of its own. app/common.ps1 finds the same programs.
    internal static class Browsers {
        internal static readonly string[] Ids={"edge","chrome","firefox"};
        static readonly string[][] Known={
            new[]{"edge","Microsoft Edge","msedge.exe",@"Microsoft\Edge\Application\msedge.exe"},
            new[]{"chrome","Google Chrome","chrome.exe",@"Google\Chrome\Application\chrome.exe"},
            new[]{"firefox","Firefox","firefox.exe",@"Mozilla Firefox\firefox.exe"}};
        static string AppPath(string file){
            foreach(var hive in new[]{Registry.CurrentUser,Registry.LocalMachine}){
                try{using(var key=hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\"+file)){string path=key==null?null:(key.GetValue("") as string??"").Trim().Trim('"');if(!String.IsNullOrEmpty(path)&&File.Exists(path))return path;}}catch{}
            }
            return null;
        }
        internal static List<BrowserChoice> Detect(){
            var found=new List<BrowserChoice>();
            foreach(var known in Known){
                string path=AppPath(known[2])??Terminals.FirstExisting(
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),known[3]),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),known[3]),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),known[3]));
                if(path!=null)found.Add(new BrowserChoice{Id=known[0],Label=known[1],Path=path});
            }
            return found;
        }
        // The program that opens web links now, for the icon of "system default". Null when unknown.
        internal static string DefaultProgram(){
            try{
                string progId;
                using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice"))progId=key==null?null:key.GetValue("ProgId") as string;
                if(String.IsNullOrEmpty(progId))return null;
                using(var key=Registry.ClassesRoot.OpenSubKey(progId+@"\shell\open\command")){
                    string command=key==null?null:key.GetValue("") as string;if(String.IsNullOrEmpty(command))return null;
                    command=command.Trim();string file=command.StartsWith("\"")?command.Substring(1,Math.Max(0,command.IndexOf('"',1)-1)):command.Split(' ')[0];
                    return File.Exists(file)?file:null;
                }
            }catch{return null;}
        }
        // The program's own icon, at the size of a menu row.
        internal static System.Drawing.Image IconOf(string file,int size){
            try{
                if(String.IsNullOrEmpty(file)||!File.Exists(file))return null;
                using(var icon=System.Drawing.Icon.ExtractAssociatedIcon(file))using(var large=icon.ToBitmap()){
                    var image=new System.Drawing.Bitmap(size,size);
                    using(var g=System.Drawing.Graphics.FromImage(image)){g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;g.DrawImage(large,new System.Drawing.Rectangle(0,0,size,size));}
                    return image;
                }
            }catch{return null;}
        }
    }
    internal static class Installation {
        const string KeyPath=@"Software\Microsoft\Windows\CurrentVersion\Uninstall\CMCP_is1";
        // Only for the copy Windows lists as installed; a portable copy elsewhere keeps its own uninstall.
        internal static string Uninstaller(string root,string keyPath=KeyPath){
            try{using(var key=Registry.CurrentUser.OpenSubKey(keyPath)){
                string location=key==null?null:key.GetValue("InstallLocation") as string,command=key==null?null:key.GetValue("UninstallString") as string;
                if(String.IsNullOrEmpty(location)||String.IsNullOrEmpty(command))return null;
                if(!String.Equals(Path.GetFullPath(location).TrimEnd('\\'),Path.GetFullPath(root).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))return null;
                string file=command.Trim().Trim('"');
                return File.Exists(file)&&Path.GetFileName(file).StartsWith("unins",StringComparison.OrdinalIgnoreCase)?file:null;
            }}catch{return null;}
        }
    }
    internal static class InstallerChoices {
        // The same two records the settings page keeps, so both always agree.
        internal static int Apply(string state,string executable,bool autoStart,string language,string keyPath=StartupRegistration.RunPath){
            try{
                bool first=!File.Exists(AppSettings.PathFor(state));
                var settings=AppSettings.Load(state);if(settings.ReadError)return 1;
                StartupRegistration.Set(executable,autoStart,keyPath);
                settings.autoStart=autoStart;if(first)settings.language=language;settings.Save(state);
                StartupPreferences.Save(state,true);
                return 0;
            }catch{return 1;}
        }
    }
    internal static class StartupRegistration {
        internal const string RunPath=@"Software\Microsoft\Windows\CurrentVersion\Run",Name="CMCPManager",LegacyName="ClaudeCloudPcLink";
        internal static bool Enabled(string keyPath=RunPath){using(var key=Registry.CurrentUser.OpenSubKey(keyPath))return key!=null&&(key.GetValue(Name)!=null||key.GetValue(LegacyName)!=null);}
        internal static void Set(string executable,bool enabled,string keyPath=RunPath){
            string exe=Path.GetFullPath(executable);if(!File.Exists(exe))throw new IOException("程序路径不存在。");
            using(var key=Registry.CurrentUser.CreateSubKey(keyPath)){
                string existing=key.GetValue(Name) as string;
                if(existing!=null&&!existing.EndsWith("\\Claude-MCP.exe\" --startup",StringComparison.OrdinalIgnoreCase)&&!existing.EndsWith("\\CMCP.exe\" --startup",StringComparison.OrdinalIgnoreCase)&&existing!="\""+exe+"\" --startup")throw new IOException("开机启动项不属于 CMCP，未覆盖。");
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
