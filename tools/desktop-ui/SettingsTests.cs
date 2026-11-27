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
        // Options live inside their rounded groups.
        static ModernButton Option(Control sheet,string text){return sheet.Controls.OfType<RoundedSheet>().SelectMany(group=>group.Controls.OfType<ModernButton>()).Single(b=>b.Text==text);}
        internal static void NativeWheel(Control target,int delta,bool pump=true){var point=target.PointToScreen(new Point(10,10));SendMessage(target.Handle,0x20a,new IntPtr(delta<<16),new IntPtr((point.Y<<16)|(point.X&0xffff)));if(pump)Application.DoEvents();}
        internal static void Run(string directory,Action<bool,string> check){
            NetworkTests(directory,check);
            ToggleScrollTests(check);
            string state=Path.Combine(directory,"settings-test");Directory.CreateDirectory(state);
            var options=AppSettings.Load(state);check(!options.autoStart&&options.closeToTray&&options.language=="zh-CN","fresh settings use Chinese and default to hiding in tray");
            File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"closeToTray\":false}");check(AppSettings.Load(state).closeToTray,"legacy close-manager choice migrates to preserving connections in tray");
            options.closeToTray=false;options.Save(state);check(!AppSettings.Load(state).closeToTray,"explicit new exit choice persists independently of legacy close setting");
            File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"futureOption\":\"keep\"}");options.language="en";options.closeToTray=true;options.Save(state);
            var loaded=AppSettings.Load(state);check(loaded.language=="en"&&loaded.closeToTray&&File.ReadAllText(AppSettings.PathFor(state)).Contains("futureOption"),"settings persist and preserve future fields without touching credentials");
            File.WriteAllText(AppSettings.PathFor(state),"{");bool rejected=false;try{loaded.Save(state);}catch{rejected=true;}check(rejected&&File.ReadAllText(AppSettings.PathFor(state))=="{","malformed application preferences are preserved");File.Delete(AppSettings.PathFor(state));
            File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"browser\":\"netscape\",\"closeWeb\":true,\"closeTerminal\":true}");var picked=AppSettings.Load(state);
            check(!picked.ReadError&&picked.browser==""&&picked.closeWeb&&picked.closeTerminal,"an unknown browser falls back to the system default and the close choices load");
            picked.browser="edge";picked.closeWeb=false;picked.Save(state);var reread=AppSettings.Load(state);
            check(reread.browser=="edge"&&!reread.closeWeb&&reread.closeTerminal&&reread.Copy().browser=="edge","the browser and close choices persist and copy");
            File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"closeWeb\":\"yes\"}");check(AppSettings.Load(state).ReadError,"a malformed close choice is refused like other settings");File.Delete(AppSettings.PathFor(state));
            string registry=@"Software\CMCP-SettingsTests-"+Guid.NewGuid().ToString("N");
            try{
                StartupRegistration.Set(Application.ExecutablePath,true,registry);using(var key=Registry.CurrentUser.OpenSubKey(registry))check(Convert.ToString(key.GetValue(StartupRegistration.Name))=="\""+Application.ExecutablePath+"\" --startup","autostart registration quotes actual executable and uses tray startup flag");
                StartupRegistration.Set(Application.ExecutablePath,false,registry);check(!StartupRegistration.Enabled(registry),"autostart can be disabled without changing unrelated registry values");
                using(var key=Registry.CurrentUser.CreateSubKey(registry))key.SetValue(StartupRegistration.Name,"unrelated.exe");rejected=false;try{StartupRegistration.Set(Application.ExecutablePath,true,registry);}catch{rejected=true;}check(rejected,"unrelated startup value cannot be overwritten");
            }finally{Registry.CurrentUser.DeleteSubKeyTree(registry,false);}
            using(var form=new Manager(true)){
                form.ClientSize=new Size(700,460);form.Show();Application.DoEvents();form.Cards.Values.First().SetExpanded(true,false);form.OpenSettings();Application.DoEvents();check(form.Settings!=null&&form.OwnedForms.Length==0,"settings use a page in the existing window");
                foreach(bool dark in new[]{false,true}){form.SetTheme(dark);form.Settings.Viewport.Wheel(-120);Application.DoEvents();check(!form.Settings.Viewport.NativeBarsVisible&&form.Settings.Viewport.AutoScrollPosition.Y<0,"settings retain wheel scrolling without native bars in "+dark);}
                var next=form.Options.Copy();next.language="en";next.closeToTray=true;form.ChangeSettings(next);check(L.Language=="en"&&L.Text("已停止")=="Stopped","language switch translates statuses immediately");
                form.CloseSettings();form.OpenAdd();Application.DoEvents();check(form.Editor.Controls.Cast<Control>().SelectMany(c=>c.Controls.Cast<Control>()).OfType<Label>().Any(l=>l.Text=="Add device"),"English applies to embedded add page");form.CloseEditor();
                form.HideToTray();check(!form.Visible&&form.TrayVisible,"hide-to-tray keeps the manager alive in isolated UI");form.RestoreManager();check(form.Visible&&form.TrayVisible,"tray restore shows the same manager instance and retains the resident icon");
                check(form.TrayItems.First()=="Open main window"&&form.TrayItems.Last()=="Exit application"&&form.TrayCommands.Targets.Count==2,"tray retains restore and full application exit around all cloud PCs");
                form.Close();check(!form.IsDisposed&&form.TrayVisible,"clicking X actually hides the manager when tray mode is selected");form.RestoreManager();
                form.Options.closeToTray=false;
                foreach(bool dark in new[]{false,true,false,true}){form.SetTheme(dark);foreach(var card in form.Cards.Values)card.SetExpanded(true,false);form.ClientSize=new Size(700,500);Application.DoEvents();check(!form.list.NativeBarsVisible,"expanded card list hides native scrollbars after theme switch "+dark);}
                int before=form.ScrollOffset;form.list.Wheel(-120);Application.DoEvents();check(form.ScrollOffset>before,"main list retains wheel scrolling without native scrollbars");
                {
                    // Real wheel messages over a card must keep the list's usable width and every card width fixed (stable right edge).
                    var probe=form.Cards.Values.First();int stable=form.list.ClientSize.Width;var cardWidths=new System.Collections.Generic.HashSet<int>();
                    form.list.ClientWidthsSeen.Clear();form.list.TraceClientWidth=true;
                    for(int i=0;i<16;i++){NativeWheel(probe,i<8?-120:120);foreach(var c in form.Cards.Values)cardWidths.Add(c.Width);}
                    form.list.TraceClientWidth=false;
                    check(form.list.ClientWidthsSeen.All(w=>w==stable)&&cardWidths.Count==1&&cardWidths.Single()==stable-2&&!form.list.NativeBarsVisible,
                        "wheel scrolling keeps the card list width and card right edges fixed (usable widths "+stable+" seen ["+String.Join(",",form.list.ClientWidthsSeen)+"] cards ["+String.Join(",",cardWidths)+"])");
                }
                {
                    // A real wheel notch glides: it moves at once but only part way, keeps animating, then settles on the whole notch.
                    var probe=form.Cards.Values.First();form.ScrollOffset=0;Application.DoEvents();
                    int start=form.ScrollOffset,goal=Math.Min(start+120,form.list.MaxScrollOffset);
                    bool forced=Motion.Forced;Motion.Forced=true;
                    try{NativeWheel(probe,-120,false);}finally{Motion.Forced=forced;}
                    int first=form.ScrollOffset;bool gliding=form.list.Gliding;
                    var clock=System.Diagnostics.Stopwatch.StartNew();while(form.list.Gliding&&clock.ElapsedMilliseconds<2000){Application.DoEvents();System.Threading.Thread.Sleep(5);}
                    int settled=form.ScrollOffset;
                    check(goal>start&&gliding&&first>start&&first<goal&&settled==goal&&!form.list.Gliding&&!form.list.NativeBarsVisible,
                        "a wheel notch glides to the whole notch instead of jumping (start "+start+" first "+first+" settled "+settled+" goal "+goal+")");
                }
                {
                    var card=form.Cards.Values.First();var bounds=form.Bounds;
                    float body=card.Font.Size,tool=form.toolbar.Font.Size;
                    bool unchanged=card.Font.Unit==GraphicsUnit.Pixel&&form.toolbar.Font.Unit==GraphicsUnit.Pixel;
                    IntPtr values=Marshal.AllocHGlobal(16);
                    try{
                        foreach(int dpi in new[]{144,192,96}){
                            Marshal.WriteInt32(values,bounds.Width);Marshal.WriteInt32(values,4,bounds.Height);
                            unchanged&=SendMessage(form.Handle,0x02e4,new IntPtr(dpi),values)==new IntPtr(1)
                                &&Marshal.ReadInt32(values)==bounds.Width&&Marshal.ReadInt32(values,4)==bounds.Height;
                            Marshal.WriteInt32(values,bounds.Left);Marshal.WriteInt32(values,4,bounds.Top);
                            Marshal.WriteInt32(values,8,bounds.Left+bounds.Width*dpi/96);
                            Marshal.WriteInt32(values,12,bounds.Top+bounds.Height*dpi/96);
                            SendMessage(form.Handle,0x02e0,new IntPtr(dpi|(dpi<<16)),values);
                            Application.DoEvents();
                            unchanged&=form.Bounds==bounds&&form.LayoutFits()&&card.Font.Size==body&&form.toolbar.Font.Size==tool;
                        }
                        form.OpenSettings();Application.DoEvents();
                        unchanged&=form.Settings.Font.Unit==GraphicsUnit.Pixel&&form.Settings.Font.Size==body;
                        form.CloseSettings();Application.DoEvents();
                    } finally{Marshal.FreeHGlobal(values);}
                    check(unchanged,"mixed-DPI moves keep window bounds, text and controls in the same layout");
                }
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
            using(var uninstallForm=new Manager(true)){
                int runs=0,stops=0;uninstallForm.ExitBackend=delegate{stops++;return true;};uninstallForm.ConfirmUninstall=()=>false;uninstallForm.RunUninstall=()=>{runs++;return 1;};
                uninstallForm.Show();Application.DoEvents();uninstallForm.OpenSettings();Application.DoEvents();uninstallForm.Settings.ShowAbout();Application.DoEvents();
                Action click=()=>uninstallForm.Settings.Viewport.Controls[0].Controls.OfType<ModernButton>().Single(b=>b.Text=="卸载").AccessibilityObject.DoDefaultAction();
                Action<Func<bool>> wait=done=>{var clock=System.Diagnostics.Stopwatch.StartNew();while(!done()&&clock.ElapsedMilliseconds<5000){Application.DoEvents();System.Threading.Thread.Sleep(5);}};
                click();Application.DoEvents();check(runs==0&&uninstallForm.Enabled&&!uninstallForm.IsDisposed,"declining the uninstall question runs nothing");
                uninstallForm.ConfirmUninstall=()=>true;click();wait(()=>runs==1&&uninstallForm.Enabled);check(runs==1&&stops==0&&uninstallForm.Enabled&&!uninstallForm.IsDisposed,"a failed uninstall keeps the manager open and usable");
                uninstallForm.RunUninstall=()=>{runs++;return 0;};click();wait(()=>uninstallForm.IsDisposed);check(runs==2&&stops==0&&uninstallForm.IsDisposed,"a finished uninstall closes the manager without running the exit backend again");
            }
            L.Set("zh-CN");check(!File.Exists(Path.Combine(state,"cloudpc-targets.json"))&&!File.Exists(Path.Combine(state,"config.json")),"settings tests never create target or credential state");
        }
        static void NetworkTests(string directory,Action<bool,string> check){
            string state=Path.Combine(directory,"network-settings");Directory.CreateDirectory(state);
            var saved=new AppSettings();check(AppSettings.Load(state).proxyMode=="auto","legacy and new settings default to automatic proxy discovery");
            saved.proxyMode="manual";saved.proxyHost="::1";saved.proxyPort=7897;saved.Save(state);var loaded=AppSettings.Load(state);
            check(!loaded.ReadError&&loaded.proxyMode=="manual"&&loaded.proxyHost=="::1"&&loaded.proxyPort==7897&&loaded.Copy().proxyPort==7897,"manual proxy and IPv6 persist across settings copies and reloads");
            string original=File.ReadAllText(AppSettings.PathFor(state));saved.proxyPort=65536;bool rejected=false;try{saved.Save(state);}catch{rejected=true;}
            check(rejected&&File.ReadAllText(AppSettings.PathFor(state))==original,"invalid proxy ports cannot overwrite saved preferences");
            check(!AppSettings.ValidProxyHost("http://127.0.0.1")&&!AppSettings.ValidProxyHost("user@host")&&!AppSettings.ValidProxyHost("host\r\nInjected"),"proxy host rejects URLs, credentials and control characters");
            using(var form=new Form{ClientSize=new Size(760,600)}){
                int changes=0;AppSettings result=null;
                var page=new SettingsPage(new AppSettings(),Palette.Create(false),next=>{changes++;result=next;},delegate{});form.Controls.Add(page);form.Show();page.ShowConnect();Application.DoEvents();
                var sheet=page.Viewport.Controls[0];var mode=sheet.Controls.OfType<DropdownField>().Single(f=>f.AccessibleName=="代理模式");
                var host=sheet.Controls.OfType<EditorInput>().Single(f=>f.Box.AccessibleName=="代理地址");var port=sheet.Controls.OfType<EditorInput>().Single(f=>f.Box.AccessibleName=="代理端口");
                var save=sheet.Controls.OfType<ModernButton>().Single(b=>b.Text=="保存代理");
                check(!host.Enabled&&!port.Enabled,"automatic proxy mode disables manual address inputs");
                mode.Choose("manual");check(host.Enabled&&port.Enabled&&changes==0,"choosing manual mode allows drafting without starting a connection");
                host.Box.Text="127.0.0.1";port.Box.Text="0";save.AccessibilityObject.DoDefaultAction();check(changes==0,"invalid proxy form values are rejected before saving");
                port.Box.Text="7897";save.AccessibilityObject.DoDefaultAction();check(changes==1&&result.proxyMode=="manual"&&result.proxyPort==7897,"explicit Save applies the complete proxy draft once");
                mode.Choose("direct");save.AccessibilityObject.DoDefaultAction();check(changes==2&&result.proxyMode=="direct"&&!host.Enabled,"direct mode is an explicit saved choice");
                foreach(int width in new[]{660,1100}){form.ClientSize=new Size(width,600);Application.DoEvents();check(host.Right<=sheet.ClientSize.Width&&port.Right<=sheet.ClientSize.Width&&!page.Viewport.NativeBarsVisible,"proxy form fits the settings viewport at "+width);}
            }
        }
        static void ToggleScrollTests(Action<bool,string> check){
            foreach(bool dark in new[]{false,true})using(var form=new Manager(true)){
                form.ClientSize=new Size(700,500);form.Show();form.SetTheme(dark);
                var options=form.Options.Copy();options.autoStart=true;form.ChangeSettings(options);form.OpenSettings();Application.DoEvents();
                var page=form.Settings;var viewport=page.Viewport;var sheet=viewport.Controls[0];var startup=sheet.Controls.OfType<CheckBox>().First();
                viewport.AutoScrollPosition=new Point(0,40);startup.Focus();Application.DoEvents();int before=-viewport.AutoScrollPosition.Y;
                startup.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(!form.Options.autoStart&&!startup.IsDisposed&&Object.ReferenceEquals(startup,sheet.Controls.OfType<CheckBox>().First()),"disabling startup keeps the focused checkbox alive in theme "+dark);
                check(-viewport.AutoScrollPosition.Y==before&&startup.Focused,"saving startup preserves settings scroll position and keyboard focus in theme "+dark);
                bool scrolls=true;
                for(int i=0;i<4;i++){
                    int start=-viewport.AutoScrollPosition.Y;viewport.Wheel(-120);Application.DoEvents();int down=-viewport.AutoScrollPosition.Y;viewport.Wheel(120);Application.DoEvents();int up=-viewport.AutoScrollPosition.Y;
                    scrolls&=down>start&&up<down;
                    startup.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                    scrolls&=!startup.IsDisposed&&form.Options.autoStart==startup.Checked&&!viewport.NativeBarsVisible;
                }
                check(scrolls,"repeated startup toggles retain wheel scrolling in both directions without native bars in theme "+dark);
                viewport.AutoScrollPosition=Point.Empty;Application.DoEvents();int nativeBefore=-viewport.AutoScrollPosition.Y;NativeWheel(startup,-120);int nativeDown=-viewport.AutoScrollPosition.Y;NativeWheel(startup,120);
                check(nativeDown>nativeBefore&&-viewport.AutoScrollPosition.Y<nativeDown,"native mouse wheel messages on the focused startup checkbox still reach the viewport in theme "+dark);
                var language=sheet.Controls.OfType<DropdownField>().First();language.Choose("en");Application.DoEvents();
                check(L.Language=="en"&&!startup.IsDisposed&&startup.Text=="Start with Windows"&&sheet.Controls.OfType<Label>().Any(label=>label.Text=="Interface language")&&language.Value=="en","language changes translate existing settings controls without replacing the focused page in theme "+dark);
                var theme=Option(sheet,dark?"浅色":"深色");theme.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(form.Preferences.dark!=dark&&!startup.IsDisposed&&form.Settings==page,"theme changes update the same settings controls in theme "+dark);
                var closing=sheet.Controls.OfType<CheckBox>().ElementAt(1);closing.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                bool exitSelected=!form.Options.closeToTray&&!closing.Checked;closing.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(exitSelected&&form.Options.closeToTray&&closing.Checked&&!startup.IsDisposed,"close behavior choices update selection without rebuilding settings in theme "+dark);
                form.CloseSettings();form.OpenSettings();Application.DoEvents();viewport=form.Settings.Viewport;viewport.Wheel(-120);Application.DoEvents();
                check(viewport.AutoScrollPosition.Y<0&&!viewport.NativeBarsVisible,"reopening settings retains wheel scrolling after startup changes in theme "+dark);
                L.Set("zh-CN");
            }
            using(var host=new Form{ClientSize=new Size(700,500)})using(var page=new SettingsPage(new AppSettings{autoStart=true},Palette.Create(false),delegate{throw new IOException("fixture save failure");},delegate{})){
                host.Controls.Add(page);host.Show();Application.DoEvents();var viewport=page.Viewport;var startup=viewport.Controls[0].Controls.OfType<CheckBox>().First();startup.Focus();startup.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(!startup.IsDisposed&&startup.Checked,"failed startup save restores the existing checkbox to its last saved state");
                viewport.AutoScrollPosition=new Point(0,40);Application.DoEvents();int before=-viewport.AutoScrollPosition.Y;NativeWheel(startup,-120);int down=-viewport.AutoScrollPosition.Y;NativeWheel(startup,120);
                check(down>before&&-viewport.AutoScrollPosition.Y<down&&!viewport.NativeBarsVisible,"save failures preserve native wheel scrolling on the same settings page");
            }
        }
    }
}
