using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CMCP {
    internal static class DesktopShortcut {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
        // Explicit Unicode Shell API; no Windows Script Host or PowerShell.
        [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellLinkW {
            void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder file,int count,IntPtr findData,uint flags);
            void GetIDList(out IntPtr list); void SetIDList(IntPtr list);
            void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder text,int count);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
            void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory,int count);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder args,int count);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
            void GetHotkey(out short key); void SetHotkey(short key);
            void GetShowCmd(out int command); void SetShowCmd(int command);
            void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder file,int count,out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string file,int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string file,uint reserved);
            void Resolve(IntPtr window,uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }
        internal const string Description = "CMCP desktop shortcut";
        static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
        internal static string[] Read(string file) {
            object shell = new ShellLink();
            try {
                ((System.Runtime.InteropServices.ComTypes.IPersistFile)shell).Load(file,0);
                var link = (IShellLinkW)shell;
                var target=new StringBuilder(32768);var directory=new StringBuilder(32768);var icon=new StringBuilder(32768);var args=new StringBuilder(32768);var description=new StringBuilder(1024);int index;
                link.GetPath(target,target.Capacity,IntPtr.Zero,4);link.GetWorkingDirectory(directory,directory.Capacity);
                link.GetIconLocation(icon,icon.Capacity,out index);link.GetArguments(args,args.Capacity);link.GetDescription(description,description.Capacity);
                return new string[] { target.ToString(),directory.ToString(),icon.ToString()+","+index,args.ToString(),description.ToString() };
            } finally { Release(shell); }
        }
        internal static string Create(string executable, string desktop) {
            string exe = Path.GetFullPath(executable);
            if (!File.Exists(exe) || String.IsNullOrWhiteSpace(desktop) || !Directory.Exists(desktop)) throw new IOException("程序或桌面目录不存在。");
            string destination = Path.Combine(desktop, "CMCP.lnk");
            byte[] original = null;
            if (Directory.Exists(destination)) throw new IOException("桌面存在同名文件夹，请先改名。");
            if (File.Exists(destination)) {
                var existing = Read(destination);
                if (existing[4] != Description && !String.Equals(existing[0],exe,StringComparison.OrdinalIgnoreCase)) throw new IOException("桌面已有同名快捷方式，且不属于本程序，请先将它改名。");
                original = File.ReadAllBytes(destination);
            }
            string temporary = Path.Combine(desktop, ".cmcp-" + Guid.NewGuid().ToString("N") + ".lnk");
            object shell = new ShellLink();
            try {
                var link = (IShellLinkW)shell;
                link.SetPath(exe); link.SetWorkingDirectory(Path.GetDirectoryName(exe));link.SetArguments("");
                link.SetIconLocation(exe,0);link.SetDescription(Description);link.SetShowCmd(1);
                ((System.Runtime.InteropServices.ComTypes.IPersistFile)shell).Save(temporary,true);
                if (original == null) File.Move(temporary,destination);
                else {
                    string before = Convert.ToBase64String(original);
                    if (!File.Exists(destination) || Convert.ToBase64String(File.ReadAllBytes(destination)) != before) throw new IOException("快捷方式已被其他程序修改，请重试。");
                    File.Replace(temporary,destination,null);
                }
                return destination;
            } finally { Release(shell); if (File.Exists(temporary)) File.Delete(temporary); }
        }
        internal static bool Exists(string executable,params string[] desktops) {
            string exe=Path.GetFullPath(executable);
            foreach(string desktop in desktops) {
                if(String.IsNullOrWhiteSpace(desktop)||!Directory.Exists(desktop))continue;
                try { foreach(string file in Directory.EnumerateFiles(desktop,"*.lnk").Take(1024)) {
                    try {
                        var link=Read(file);string target=link[0];
                        if(link[3].Length!=0||target.Length<3||target[1]!=':'||target[2]!='\\')continue;
                        bool owned=link[4]==Description&&(String.Equals(Path.GetFileName(target),"CMCP.exe",StringComparison.OrdinalIgnoreCase)||String.Equals(Path.GetFileName(target),"Claude-MCP.exe",StringComparison.OrdinalIgnoreCase));
                        if((owned||String.Equals(Path.GetFullPath(target),exe,StringComparison.OrdinalIgnoreCase))&&File.Exists(target))return true;
                    }catch{}
                }}catch{}
            }
            return false;
        }
    }

    internal static class StartupPreferences {
        internal static string FileName(string directory) { return Path.Combine(directory,"manager-preferences.json"); }
        static Dictionary<string,object> Read(string file) {
            try {
                if (!File.Exists(file) || new FileInfo(file).Length > 16384) return new Dictionary<string,object>();
                return new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 }.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8)) ?? new Dictionary<string,object>();
            } catch { return new Dictionary<string,object>(); }
        }
        internal static bool ShouldPrompt(string directory) {
            object value; var data = Read(FileName(directory));
            return !data.TryGetValue("suppressDesktopShortcutPrompt",out value) || !Object.Equals(value,true);
        }
        internal static bool ShouldPrompt(string directory,string executable,params string[] desktops) {
            return ShouldPrompt(directory)&&!DesktopShortcut.Exists(executable,desktops);
        }
        internal static void Save(string directory, bool suppress) {
            Directory.CreateDirectory(directory);
            string file = FileName(directory), key;
            using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(file).ToLowerInvariant()))).Replace("-","").Substring(0,20);
            using (var mutex = new Mutex(false,"Local\\CMCP-Preferences-" + key)) {
                bool held = false;
                try {
                    try { held = mutex.WaitOne(3000); } catch (AbandonedMutexException) { held = true; }
                    if (!held) throw new IOException("设置正在被其他窗口更新。");
                    var data = Read(file); data["schema"] = 1; data["suppressDesktopShortcutPrompt"] = suppress;
                    string temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try {
                        File.WriteAllText(temp,new JavaScriptSerializer().Serialize(data),new UTF8Encoding(false));
                        if (File.Exists(file)) File.Replace(temp,file,null); else File.Move(temp,file);
                    } finally { if (File.Exists(temp)) File.Delete(temp); }
                } finally { if (held) mutex.ReleaseMutex(); }
            }
        }
        internal static void Apply(bool create, bool remember, string exe, string desktop, string stateDirectory) {
            // Failed creation must not suppress the user's chance to retry.
            if (create) DesktopShortcut.Create(exe,desktop);
            Save(stateDirectory,remember);
        }
    }

    internal sealed class ShortcutPrompt : Form {
        readonly CheckBox remember = new CheckBox();
        internal bool Remember { get { return remember.Checked; } }
        internal ShortcutPrompt() {
            Text = "CMCP"; Font = new Font("Microsoft YaHei UI",10F);
            ClientSize = new Size(460,208); FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Program.ExecutablePath);
            Controls.Add(new Label { Text = L.Text("是否创建桌面快捷方式？"), Location = new Point(24,22), AutoSize = true, Font = new Font(Font,FontStyle.Bold) });
            Controls.Add(new Label { Text = L.Text("名称：CMCP\r\n快捷方式将打开本机连接管理界面。"), Location = new Point(24,57), Size = new Size(410,49) });
            remember.Text = L.Text("下次不再提示"); remember.Location = new Point(24,115); remember.AutoSize = true; Controls.Add(remember);
            var yes = new Button { Text = L.Text("是"), DialogResult = DialogResult.Yes, Location = new Point(237,160), Size = new Size(90,32) };
            var no = new Button { Text = L.Text("否"), DialogResult = DialogResult.No, Location = new Point(339,160), Size = new Size(90,32) };
            Controls.Add(yes); Controls.Add(no); AcceptButton = no; CancelButton = no;
        }
        internal static void AskBeforeManager() {
            string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClaudeLocalMcp");
            if (!StartupPreferences.ShouldPrompt(state,Program.ExecutablePath,Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory))) return;
            using (var prompt = new ShortcutPrompt()) {
                var result = prompt.ShowDialog();
                try {
                    StartupPreferences.Apply(result == DialogResult.Yes,prompt.Remember,Program.ExecutablePath,Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),state);
                } catch (Exception error) {
                    string detail = error is IOException ? error.Message : "请检查桌面和本机设置目录是否允许写入。";
                    MessageBox.Show("快捷方式或提示偏好未能保存：\r\n" + detail + "\r\n\r\n仍可继续使用连接管理界面。","CMCP",MessageBoxButtons.OK,MessageBoxIcon.Information);
                }
            }
        }
    }
}
