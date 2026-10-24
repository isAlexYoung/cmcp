using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CMCP {
    internal static class ShortcutTests {
        static void PromptChoice(DialogResult choice, bool remember, Action<DialogResult,bool> verify) {
            using (var form = new ShortcutPrompt()) {
                form.Controls.OfType<CheckBox>().Single().Checked = remember;
                form.Shown += delegate { form.BeginInvoke(new Action(delegate { form.Controls.OfType<Button>().Single(b => b.DialogResult == choice).PerformClick(); })); };
                var result = form.ShowDialog(); verify(result,form.Remember);
            }
        }
        internal static void Run(string testRoot, Action<bool,string> check) {
            string root = Path.Combine(testRoot,"shortcut-tests"), desktop = Path.Combine(root,"Desktop"), state = Path.Combine(root,"state"), moved = Path.Combine(root,"中文 folder's"), app = Path.Combine(root,"app");
            Directory.CreateDirectory(desktop); Directory.CreateDirectory(app); Directory.CreateDirectory(moved);
            string exe = Path.Combine(app,"CMCP.exe"), movedExe = Path.Combine(moved,"CMCP.exe"), shortcut = Path.Combine(desktop,"CMCP.lnk");
            File.Copy(Application.ExecutablePath,exe); File.Copy(Application.ExecutablePath,movedExe);
            try {
                check(StartupPreferences.ShouldPrompt(state),"fresh account asks about desktop shortcut");
                PromptChoice(DialogResult.No,false,(result,remember) => { StartupPreferences.Apply(result==DialogResult.Yes,remember,exe,desktop,state); });
                check(!File.Exists(shortcut) && StartupPreferences.ShouldPrompt(state),"No without checkbox creates nothing and asks next time");
                PromptChoice(DialogResult.No,true,(result,remember) => { StartupPreferences.Apply(result==DialogResult.Yes,remember,exe,desktop,state); });
                check(!File.Exists(shortcut) && !StartupPreferences.ShouldPrompt(state),"No with checkbox suppresses next prompt");
                PromptChoice(DialogResult.Yes,false,(result,remember) => { StartupPreferences.Apply(result==DialogResult.Yes,remember,exe,desktop,state); });
                check(File.Exists(shortcut) && StartupPreferences.ShouldPrompt(state)&&!StartupPreferences.ShouldPrompt(state,exe,desktop),"Yes without checkbox creates a shortcut and its existence suppresses the next prompt");
                string preferenceBefore=File.ReadAllText(StartupPreferences.FileName(state));
                check(!StartupPreferences.ShouldPrompt(state,exe,desktop)&&File.ReadAllText(StartupPreferences.FileName(state))==preferenceBefore,"existing shortcut suppresses prompt without rewriting the checkbox preference");
                string renamed=Path.Combine(desktop,"我的 CMCP.lnk");File.Move(shortcut,renamed);
                check(!StartupPreferences.ShouldPrompt(state,exe,desktop),"renamed owned shortcut is detected without recreating or modifying it");File.Move(renamed,shortcut);
                check(!StartupPreferences.ShouldPrompt(state,exe,Path.Combine(root,"missing-desktop"),desktop),"desktop detection accepts a later desktop location and ignores missing locations");
                var properties = DesktopShortcut.Read(shortcut);
                check(String.Equals(properties[0],exe,StringComparison.OrdinalIgnoreCase) && String.Equals(properties[1],app,StringComparison.OrdinalIgnoreCase),"shortcut points at current EXE with portable working directory");
                check(properties[2].Trim('"').EndsWith("CMCP.exe,0",StringComparison.OrdinalIgnoreCase) && properties[3]=="", "shortcut uses embedded Claude icon and no startup arguments");
                using (var icon = Icon.ExtractAssociatedIcon(exe)) check(icon!=null && icon.Width>0,"Claude icon is embedded and available without Claude installation");
                StartupPreferences.Apply(true,true,exe,desktop,state);
                check(!StartupPreferences.ShouldPrompt(state),"Yes with checkbox persists suppression");
                DesktopShortcut.Create(movedExe,desktop);
                check(String.Equals(DesktopShortcut.Read(shortcut)[0],movedExe,StringComparison.OrdinalIgnoreCase),"owned shortcut updates to moved Unicode and apostrophe path");
                StartupPreferences.Save(state,false);
                check(!StartupPreferences.ShouldPrompt(state,exe,desktop),"existing owned shortcut in another valid portable directory also suppresses prompt");
                File.Move(movedExe,movedExe+".hold");
                check(StartupPreferences.ShouldPrompt(state,exe,desktop),"broken owned shortcut with a missing target does not suppress creation prompt");File.Move(movedExe+".hold",movedExe);
                byte[] original=File.ReadAllBytes(shortcut);
                object shell=null,link=null;
                try {
                    shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell",true));
                    link=shell.GetType().InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{shortcut});
                    link.GetType().InvokeMember("Description",BindingFlags.SetProperty,null,link,new object[]{"unrelated shortcut"});
                    link.GetType().InvokeMember("TargetPath",BindingFlags.SetProperty,null,link,new object[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"notepad.exe")});
                    link.GetType().InvokeMember("Save",BindingFlags.InvokeMethod,null,link,null);
                } finally { if(link!=null)Marshal.FinalReleaseComObject(link);if(shell!=null)Marshal.FinalReleaseComObject(shell); }
                original=File.ReadAllBytes(shortcut); bool conflict=false;
                try { DesktopShortcut.Create(exe,desktop); } catch (IOException) { conflict=true; }
                check(conflict && Convert.ToBase64String(original)==Convert.ToBase64String(File.ReadAllBytes(shortcut)),"unrelated same-name shortcut is preserved");
                check(StartupPreferences.ShouldPrompt(state,exe,desktop),"unrelated same-name shortcut does not count as an existing CMCP shortcut");
                File.WriteAllText(shortcut,"not a shell link");check(StartupPreferences.ShouldPrompt(state,exe,desktop),"invalid shell link does not suppress prompt or crash startup");
                StartupPreferences.Save(state,false);
                bool failed=false; try { StartupPreferences.Apply(true,true,exe,Path.Combine(root,"missing-desktop"),state); } catch (IOException) { failed=true; }
                check(failed && StartupPreferences.ShouldPrompt(state),"failed shortcut creation does not suppress retry");
                File.WriteAllText(StartupPreferences.FileName(state),"{");
                check(StartupPreferences.ShouldPrompt(state),"corrupt preferences do not silently suppress prompt");
                File.WriteAllText(StartupPreferences.FileName(state),"{\"schema\":1,\"futureSetting\":\"keep\"}");
                StartupPreferences.Save(state,true);
                check(File.ReadAllText(StartupPreferences.FileName(state)).Contains("keep"),"saving prompt preference preserves other settings");
                check(!File.Exists(Path.Combine(state,"config.json")) && !File.Exists(Path.Combine(state,"cloudpc-targets.json")) && !File.Exists(Path.Combine(state,"stopped.flag")),"shortcut feature does not create credentials, targets or service stop flag");
            } finally {
                foreach(string file in new string[]{shortcut,exe,movedExe,StartupPreferences.FileName(state)}) if(File.Exists(file))File.Delete(file);
                foreach(string directory in new string[]{desktop,state,moved,app,root}) if(Directory.Exists(directory))Directory.Delete(directory,false);
            }
        }
    }
}
