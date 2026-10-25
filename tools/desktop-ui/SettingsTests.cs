using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CMCP {
    internal static class SettingsTests {
        [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,IntPtr lParam);
        static void NativeWheel(Control target,int delta){var point=target.PointToScreen(new Point(10,10));SendMessage(target.Handle,0x20a,new IntPtr(delta<<16),new IntPtr((point.Y<<16)|(point.X&0xffff)));Application.DoEvents();}
        internal static void Run(string directory,Action<bool,string> check){
            ToggleScrollTests(check);
            string state=Path.Combine(directory,"settings-test");Directory.CreateDirectory(state);
            var options=AppSettings.Load(state);check(!options.autoStart&&options.closeToTray&&options.language=="zh-CN","fresh settings use Chinese and default to hiding in tray");
            File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"closeToTray\":false}");check(AppSettings.Load(state).closeToTray,"legacy close-manager choice migrates to preserving connections in tray");
            options.closeToTray=false;options.Save(state);check(!AppSettings.Load(state).closeToTray,"explicit new exit choice persists independently of legacy close setting");
            File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"futureOption\":\"keep\"}");options.language="en";options.closeToTray=true;options.Save(state);
            var loaded=AppSettings.Load(state);check(loaded.language=="en"&&loaded.closeToTray&&File.ReadAllText(AppSettings.PathFor(state)).Contains("futureOption"),"settings persist and preserve future fields without touching credentials");
            File.WriteAllText(AppSettings.PathFor(state),"{");bool rejected=false;try{loaded.Save(state);}catch{rejected=true;}check(rejected&&File.ReadAllText(AppSettings.PathFor(state))=="{","malformed application preferences are preserved");File.Delete(AppSettings.PathFor(state));
            string registry=@"Software\CMCP-SettingsTests-"+Guid.NewGuid().ToString("N");
            try{
                StartupRegistration.Set(Application.ExecutablePath,true,registry);using(var key=Registry.CurrentUser.OpenSubKey(registry))check(Convert.ToString(key.GetValue(StartupRegistration.Name))=="\""+Application.ExecutablePath+"\" --startup","autostart registration quotes actual executable and uses tray startup flag");
                StartupRegistration.Set(Application.ExecutablePath,false,registry);check(!StartupRegistration.Enabled(registry),"autostart can be disabled without changing unrelated registry values");
                using(var key=Registry.CurrentUser.CreateSubKey(registry))key.SetValue(StartupRegistration.Name,"unrelated.exe");rejected=false;try{StartupRegistration.Set(Application.ExecutablePath,true,registry);}catch{rejected=true;}check(rejected,"unrelated startup value cannot be overwritten");
            }finally{Registry.CurrentUser.DeleteSubKeyTree(registry,false);}
            using(var form=new Manager(true)){
                form.Show();Application.DoEvents();form.Cards.Values.First().SetExpanded(true,false);form.OpenSettings();Application.DoEvents();check(form.Settings!=null&&form.OwnedForms.Length==0,"settings use a page in the existing window");
                foreach(bool dark in new[]{false,true}){form.SetTheme(dark);form.Settings.Viewport.Wheel(-120);Application.DoEvents();check(!form.Settings.Viewport.NativeBarsVisible&&form.Settings.Viewport.AutoScrollPosition.Y<0,"settings retain wheel scrolling without native bars in "+dark);}
                var next=form.Options.Copy();next.language="en";next.closeToTray=true;form.ChangeSettings(next);check(L.Language=="en"&&L.Text("已停止")=="Stopped","language switch translates statuses immediately");
                form.CloseSettings();form.OpenAdd();Application.DoEvents();check(form.Editor.Controls.Cast<Control>().SelectMany(c=>c.Controls.Cast<Control>()).OfType<Label>().Any(l=>l.Text=="Add cloud PC"),"English applies to embedded add page");form.CloseEditor();
                form.HideToTray();check(!form.Visible&&form.TrayVisible,"hide-to-tray keeps the manager alive in isolated UI");form.RestoreManager();check(form.Visible&&!form.TrayVisible,"tray restore shows the same manager instance");
                check(form.TrayItems.SequenceEqual(new[]{"Open main window","Exit application"}),"tray has exactly restore and full application exit actions");
                form.Close();check(!form.IsDisposed&&form.TrayVisible,"clicking X actually hides the manager when tray mode is selected");form.RestoreManager();
                form.Options.closeToTray=false;
                foreach(bool dark in new[]{false,true,false,true}){form.SetTheme(dark);foreach(var card in form.Cards.Values)card.SetExpanded(true,false);form.ClientSize=new Size(700,500);Application.DoEvents();check(!form.list.NativeBarsVisible,"expanded card list hides native scrollbars after theme switch "+dark);}
                int before=form.ScrollOffset;form.list.Wheel(-120);Application.DoEvents();check(form.ScrollOffset>before,"main list retains wheel scrolling without native scrollbars");
                int clicked=0;var button=form.Cards.Values.First().Toggle;button.Click+=delegate{clicked++;};button.AccessibilityObject.DoDefaultAction();check(clicked==1,"custom button provides a real accessible default action");
            }
            using(var exitForm=new Manager(true)){
                int stops=0;exitForm.ExitBackend=delegate{stops++;return true;};exitForm.Options.closeToTray=false;exitForm.Show();Application.DoEvents();exitForm.Close();Application.DoEvents();
                check(stops==1&&exitForm.IsDisposed,"direct-close option disconnects backend before closing manager");
            }
            using(var trayForm=new Manager(true)){
                int stops=0;trayForm.ExitBackend=delegate{stops++;return true;};trayForm.Show();Application.DoEvents();trayForm.Close();Application.DoEvents();
                check(stops==0&&!trayForm.IsDisposed&&trayForm.TrayVisible,"default X hides without stopping connections");trayForm.ExitApplication();Application.DoEvents();
                check(stops==1&&trayForm.IsDisposed,"explicit tray exit disconnects backend and closes manager");
            }
            L.Set("zh-CN");check(!File.Exists(Path.Combine(state,"cloudpc-targets.json"))&&!File.Exists(Path.Combine(state,"config.json")),"settings tests never create target or credential state");
        }
        static void ToggleScrollTests(Action<bool,string> check){
            foreach(bool dark in new[]{false,true})using(var form=new Manager(true)){
                form.ClientSize=new Size(700,500);form.Show();form.SetTheme(dark);
                var options=form.Options.Copy();options.autoStart=true;form.ChangeSettings(options);form.OpenSettings();Application.DoEvents();
                var page=form.Settings;var viewport=page.Viewport;var sheet=viewport.Controls[0];var startup=sheet.Controls.OfType<CheckBox>().Single();
                viewport.AutoScrollPosition=new Point(0,200);startup.Focus();Application.DoEvents();int before=-viewport.AutoScrollPosition.Y;
                startup.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(!form.Options.autoStart&&!startup.IsDisposed&&Object.ReferenceEquals(startup,sheet.Controls.OfType<CheckBox>().Single()),"disabling startup keeps the focused checkbox alive in theme "+dark);
                check(-viewport.AutoScrollPosition.Y==before&&startup.Focused,"saving startup preserves settings scroll position and keyboard focus in theme "+dark);
                bool scrolls=true;
                for(int i=0;i<4;i++){
                    int start=-viewport.AutoScrollPosition.Y;viewport.Wheel(-120);Application.DoEvents();int down=-viewport.AutoScrollPosition.Y;viewport.Wheel(120);Application.DoEvents();int up=-viewport.AutoScrollPosition.Y;
                    scrolls&=down>start&&up<down;
                    startup.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                    scrolls&=!startup.IsDisposed&&form.Options.autoStart==startup.Checked&&!viewport.NativeBarsVisible;
                }
                check(scrolls,"repeated startup toggles retain wheel scrolling in both directions without native bars in theme "+dark);
                int nativeBefore=-viewport.AutoScrollPosition.Y;NativeWheel(startup,-120);int nativeDown=-viewport.AutoScrollPosition.Y;NativeWheel(startup,120);
                check(nativeDown>nativeBefore&&-viewport.AutoScrollPosition.Y<nativeDown,"native mouse wheel messages on the focused startup checkbox still reach the viewport in theme "+dark);
                var language=sheet.Controls.OfType<ModernButton>().Single(b=>b.Text=="English");language.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(L.Language=="en"&&!startup.IsDisposed&&startup.Text=="Start with Windows"&&sheet.Controls.OfType<Label>().Any(label=>label.Text=="Interface language")&&sheet.Controls.OfType<ModernButton>().Single(b=>b.Text=="English").Primary,"language changes translate existing settings controls without replacing the focused page in theme "+dark);
                var theme=sheet.Controls.OfType<ModernButton>().Single(b=>b.Text==(dark?"浅色":"深色"));theme.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(form.Preferences.dark!=dark&&!startup.IsDisposed&&form.Settings==page,"theme changes update the same settings controls in theme "+dark);
                var exit=sheet.Controls.OfType<ModernButton>().Single(b=>b.Text=="直接退出程序");var tray=sheet.Controls.OfType<ModernButton>().Single(b=>b.Text=="隐藏到系统托盘");exit.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                bool exitSelected=!form.Options.closeToTray&&exit.Primary&&!tray.Primary;tray.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(exitSelected&&form.Options.closeToTray&&tray.Primary&&!exit.Primary&&!startup.IsDisposed,"close behavior choices update selection without rebuilding settings in theme "+dark);
                form.CloseSettings();form.OpenSettings();Application.DoEvents();viewport=form.Settings.Viewport;viewport.Wheel(-120);Application.DoEvents();
                check(viewport.AutoScrollPosition.Y<0&&!viewport.NativeBarsVisible,"reopening settings retains wheel scrolling after startup changes in theme "+dark);
                L.Set("zh-CN");
            }
            using(var host=new Form{ClientSize=new Size(700,500)})using(var page=new SettingsPage(new AppSettings{autoStart=true},Palette.Create(false),delegate{throw new IOException("fixture save failure");},delegate{})){
                host.Controls.Add(page);host.Show();Application.DoEvents();var viewport=page.Viewport;var startup=viewport.Controls[0].Controls.OfType<CheckBox>().Single();startup.Focus();startup.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(!startup.IsDisposed&&startup.Checked,"failed startup save restores the existing checkbox to its last saved state");
                viewport.AutoScrollPosition=new Point(0,200);Application.DoEvents();int before=-viewport.AutoScrollPosition.Y;NativeWheel(startup,-120);int down=-viewport.AutoScrollPosition.Y;NativeWheel(startup,120);
                check(down>before&&-viewport.AutoScrollPosition.Y<down&&!viewport.NativeBarsVisible,"save failures preserve native wheel scrolling on the same settings page");
            }
        }
    }
}
