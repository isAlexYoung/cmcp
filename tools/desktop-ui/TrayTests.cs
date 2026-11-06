using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CMCP {
    internal static class TrayTests {
        // A real screen grab, so the rounded corners and shadow Windows draws are in the picture.
        internal static void Capture(string path,bool dark){
            L.Set("zh-CN");
            using(var host=new Form{FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Bounds=new Rectangle(40,40,760,440),BackColor=dark?Color.FromArgb(27,36,51):Color.FromArgb(201,214,232)})
            using(var menu=new TrayMenu(delegate{},delegate{},delegate{},delegate{},()=>dark)){
                host.Show();
                menu.Sync(new[]{new TrayTarget{Name="A",Label="工作电脑",State="已连接",Tone=1,CanDisconnect=true,CanRename=true,CanSwitch=true},new TrayTarget{Name="B",Label="desktop.example.com",State="已停止",CanConnect=true,CanRename=true,CanSwitch=true},new TrayTarget{Name="C",Label="香港 VPS",State="SSH",Tone=2,Ssh=true,CanConnect=true,CanRename=true,CanSwitch=true}});
                menu.ShowAt(host.PointToScreen(new Point(340,360)));var item=menu.Targets["C"];item.Select();item.ShowDropDown();item.DropDown.Items[0].Select();
                for(int i=0;i<6;i++){Application.DoEvents();System.Threading.Thread.Sleep(50);}
                Rectangle area=Rectangle.Inflate(Rectangle.Union(TrayDisplay.Bounds(menu.Menu),TrayDisplay.Bounds(item.DropDown)),24,24);
                using(var bitmap=new Bitmap(area.Width,area.Height)){
                    using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(area.Location,Point.Empty,area.Size);
                    bitmap.Save(Path.GetFullPath(path),System.Drawing.Imaging.ImageFormat.Png);
                }
                menu.Menu.Close();
            }
        }
        internal static void Run(string directory,Action<bool,string> check){
            Positions(check);
            MixedDisplays(check);
            using(var form=new Manager(true)){
                form.Show();Application.DoEvents();var menu=form.TrayCommands;
                check(form.TrayVisible&&form.Visible&&menu.Targets.Count==2,"launch keeps a resident tray icon alongside the visible main window");
                check(form.Options.theme=="system"&&form.Preferences.dark==AppSettings.SystemDark(false,false),"main window defaults to the current system app theme");
                var a=menu.Targets["preview-a"];var b=menu.Targets["preview-b"];
                check(a.Text=="desktop1.example.com · 已连接"&&b.Text=="desktop2.example.com · 已停止","tray lists every cloud hostname and current connection state");
                check(a.DropDownItems.Count==5&&a.DropDownItems.Cast<ToolStripItem>().Take(3).Select(i=>i.Text).SequenceEqual(new[]{"连接设备","断开设备","重命名"})&&a.DropDownItems[3] is ToolStripSeparator&&a.DropDownItems[4].Text==(form.Cards["preview-a"].SshActive?"切换为网页登录":"切换为 SSH 登录"),"hoverable cloud row provides three target actions and a sign-in switch");
                check(!a.DropDownItems[0].Enabled&&a.DropDownItems[1].Enabled&&b.DropDownItems[0].Enabled&&!b.DropDownItems[1].Enabled,"tray connect and disconnect availability follows each cloud state");
                form.HideToTray();b.DropDownItems[0].PerformClick();
                check(!form.Visible&&form.TrayVisible&&form.Cards["preview-b"].Target.State=="connected"&&form.Cards["preview-a"].Target.State=="connected","tray connects only selected cloud without opening or hiding the resident icon");
                b.DropDownItems[1].PerformClick();check(form.Cards["preview-b"].Target.State=="stopped"&&form.Cards["preview-a"].Target.State=="connected","tray disconnect preserves the other cloud connection");
                bool wasSsh=form.Cards["preview-b"].SshActive;b.DropDownItems[4].PerformClick();Application.DoEvents();
                check(form.Cards["preview-b"].SshActive!=wasSsh&&form.Cards["preview-a"].SshActive==(a.DropDownItems[4].Text=="切换为网页登录")&&b.DropDownItems[4].Text==(wasSsh?"切换为 SSH 登录":"切换为网页登录")&&!form.Visible,"tray switch changes only that device's sign-in, relabels itself and keeps the window hidden");
                b.DropDownItems[4].PerformClick();Application.DoEvents();
                var icon=(NotifyIcon)typeof(Manager).GetField("tray",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(form);icon.Visible=true;
                var iconWindow=(NativeWindow)typeof(NotifyIcon).GetField("window",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(icon);
                PostMessage(iconWindow.Handle,0x800,IntPtr.Zero,new IntPtr(0x202));Application.DoEvents();Application.DoEvents();
                check(form.Visible&&form.WindowState!=FormWindowState.Minimized&&!menu.Menu.Visible,"a left click on the tray icon opens the main window without the menu");
                icon.Visible=false;form.HideToTray();
                var targets=form.Cards.Values.Select(c=>c.Target).ToList();form.Preferences.Set("preview-b","研发 & 测试","",targets);form.Cards["preview-b"].UpdatePreference(form.Preferences.Get("preview-b"));form.RefreshState();
                check(b.Text=="研发 && 测试 · 已停止"&&b.ToolTipText=="研发 & 测试 · 已停止","tray prefers remarks and escapes menu mnemonic characters");
                form.RestoreManager();menu.Menu.Show(form,new Point(30,70));b.ShowDropDown();Application.DoEvents();
                form.Cards["preview-b"].Target.State="offline";form.RefreshState();Application.DoEvents();
                check(menu.Menu.Visible&&b.DropDown.Visible&&Object.ReferenceEquals(b,menu.Targets["preview-b"])&&b.Text.Contains("等待网络恢复"),"live status refresh preserves the open tray menu and cloud submenu");
                menu.Menu.Close();var next=form.Options.Copy();next.language="en";form.ChangeSettings(next);
                check(menu.Targets["preview-b"].Text.Contains("Waiting for network")&&b.DropDownItems.Cast<ToolStripItem>().Select(i=>i.Text).SequenceEqual(new[]{"Connect device","Disconnect device","Rename","",form.Cards["preview-b"].SshActive?"Switch to web sign-in":"Switch to SSH sign-in"}),"tray captions and actions follow the selected interface language");
                form.OpenSettings();b.DropDownItems[2].PerformClick();Application.DoEvents();
                check(form.Visible&&form.TrayVisible&&form.Settings==null&&form.Editor!=null&&form.Editor.TargetName=="preview-b"&&form.Editor.NameInput.Box.Focused,"tray rename opens the existing edit page and focuses the display name");
                form.Editor.NameInput.Box.Text="Renamed cloud";form.Editor.Save.PerformClick();Application.DoEvents();
                check(form.Editor==null&&b.Text.StartsWith("Renamed cloud · ")&&form.Cards["preview-a"].Target.State=="connected"&&form.Cards["preview-b"].Target.State=="offline","tray rename updates the remark without changing either connection");
                b.DropDownItems[2].PerformClick();form.Editor.NameInput.Box.Text="Unsaved remark";a.DropDownItems[2].PerformClick();
                check(form.Editor.TargetName=="preview-b"&&form.Editor.NameInput.Box.Text=="Unsaved remark","renaming another tray cloud never discards an unsaved editor");form.CloseEditor();
                int stops=0;form.ExitBackend=delegate{stops++;return true;};form.Options.closeToTray=false;
                check(form.TrayVisible,"direct-exit close preference does not remove the resident tray icon");
                form.Close();Application.DoEvents();check(stops==1&&form.IsDisposed&&!form.TrayVisible,"direct X exit stops all connections and removes the resident tray icon");
            }
            L.Set("zh-CN");bool dark=false;string invoked="";
            using(var menu=new TrayMenu(delegate{},delegate{},delegate{},(id,action)=>invoked=id+":"+action,()=>dark)){
                menu.Sync(new TrayTarget[0]);check(menu.Targets.Count==0&&menu.Menu.Items.OfType<ToolStripMenuItem>().Any(i=>i.Text=="暂无设备"&&!i.Enabled),"empty tray has a disabled no-cloud hint and preserves application actions");
                var values=Enumerable.Range(0,100).Select(i=>new TrayTarget{Name="id-"+i,Label="Same note",State="已停止",CanConnect=true,CanRename=true}).ToList();menu.Sync(values);
                check(menu.Targets.Count==100&&menu.Menu.Items.Count==104,"tray includes all one hundred supported clouds without a fixed entry cap");
                menu.Targets["id-73"].DropDownItems[0].PerformClick();check(invoked=="id-73:connect","duplicate remarks still dispatch using the immutable cloud identity");
                dark=true;menu.ApplySystemTheme();check(menu.Colors.Dark&&menu.Menu.BackColor==TrayLook.Create(true).Back&&menu.Targets["id-73"].DropDown.BackColor==menu.Menu.BackColor,"root and nested tray menus follow dark system colors independently of app theme");
                dark=false;menu.ApplySystemTheme();check(!menu.Colors.Dark&&menu.Menu.ForeColor==TrayLook.Create(false).Text,"tray reacts to switching the system back to light colors");
                menu.Sync(values.Take(1).ToList());check(menu.Targets.Count==1&&menu.Targets.ContainsKey("id-0")&&menu.Menu.Items.Count==5,"removed cloud rows disappear without leaving stale tray commands");
            }
            string state=Path.Combine(directory,"tray-defaults");Directory.CreateDirectory(state);
            try{
                File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"theme\":\"\"}");check(AppSettings.Load(state).theme=="system","legacy unspecified theme migrates to following the system");
                File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"theme\":\"dark\"}");check(AppSettings.Load(state).theme=="dark","explicit user theme choice is retained across the tray update");
            }finally{File.Delete(AppSettings.PathFor(state));Directory.Delete(state,false);}
        }
        static void Positions(Action<bool,string> check){
            bool fits=true;
            foreach(var area in new[]{new Rectangle(0,0,1920,1040),new Rectangle(-2560,0,2560,1400),new Rectangle(0,-1440,2560,1400),new Rectangle(40,32,1280,900)})
                foreach(int scale in new[]{100,125,150,200})
                    foreach(var point in new[]{new Point(area.Left+3,area.Top+3),new Point(area.Right-3,area.Top+3),new Point(area.Left+3,area.Bottom-3),new Point(area.Right-3,area.Bottom-3)}){
                        var size=new Size(200*scale/100,120*scale/100);var bounds=new Rectangle(TrayMenu.Position(point,size,area),size);fits&=area.Contains(bounds);
                    }
            check(fits,"tray placement stays inside each monitor work area at every corner and common display scale");
            check(TrayMenu.Position(new Point(-50,1000),new Size(240,120),new Rectangle(-1920,0,1920,1080))==new Point(-290,880),"tray placement preserves negative monitor coordinates without jumping to the primary display");
            check(TrayMenu.Position(new Point(10,45),new Size(240,120),new Rectangle(0,40,1920,1040))==new Point(0,40),"tray placement respects reserved taskbar space at the top edge");
            bool dark=false;TrayMenu tray=null;int refreshes=0;Point click=Point.Empty;
            Action refresh=delegate{refreshes++;tray.Sync(new[]{new TrayTarget{Name="a",Label="Refreshed cloud",State="已停止",CanConnect=true,CanRename=true}});};
            using(var owner=new Form{ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Bounds=new Rectangle(70,70,320,200)})
            using(tray=new TrayMenu(refresh,delegate{},delegate{},delegate{},()=>dark,()=>click)){
                owner.Show();Application.DoEvents();
                var area=Screen.FromControl(owner).WorkingArea;var point=new Point(area.Right-80,area.Bottom-70);
                tray.ShowAt(point);Application.DoEvents();
                check(refreshes==1&&tray.Menu.Visible&&tray.Menu.Location==TrayMenu.Position(point,tray.Menu.Size,area),"first tray popup anchors after its opening refresh instead of using an uninitialized screen position");
                dark=true;tray.Sync(new[]{new TrayTarget{Name="a",Label="A much longer cloud remark after connection refresh",State="等待网络恢复",CanDisconnect=true,CanRename=true}});Application.DoEvents();
                check(tray.Menu.Visible&&tray.Menu.Location==TrayMenu.Position(point,tray.Menu.Size,area),"live cloud and system theme changes preserve the original tray click anchor");
                tray.Menu.Location=new Point(area.Left+32,area.Top+28);Application.DoEvents();
                check(tray.Menu.Visible&&tray.Menu.Location==TrayMenu.Position(point,tray.Menu.Size,area),"late native relocation cannot leave the visible tray menu at the screen origin");
                var row=tray.Targets["a"];row.ShowDropDown();Application.DoEvents();
                check(row.DropDown.Visible&&Screen.FromRectangle(row.DropDown.Bounds).WorkingArea.IntersectsWith(row.DropDown.Bounds)&&Math.Abs(row.DropDown.Top-tray.Menu.Top)<tray.Menu.Height,"cloud submenu remains beside its anchored parent menu");
                tray.Menu.Close();var second=new Point(area.Left+40,area.Top+40);tray.ShowAt(second);Application.DoEvents();
                check(refreshes==2&&tray.Menu.Location==TrayMenu.Position(second,tray.Menu.Size,area),"reopening tray menu captures the new click instead of reusing the previous position");
                tray.Menu.Close();owner.Hide();Application.DoEvents();click=point;
                using(var notification=new NotifyIcon{Icon=SystemIcons.Application,ContextMenuStrip=tray.ActivationMenu,Visible=true}){
                    typeof(NotifyIcon).GetMethod("ShowContextMenu",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(notification,null);Application.DoEvents();
                    check(!owner.Visible&&tray.Menu.Visible&&tray.Menu.Location==TrayMenu.Position(point,tray.Menu.Size,area),"hidden main window preserves notification popup placement: owner="+owner.Visible+", menu="+tray.Menu.Visible+", actual="+tray.Menu.Location+", expected="+TrayMenu.Position(point,tray.Menu.Size,area));
                    tray.Menu.Close();
                    click=new Point(area.Right-180,area.Bottom-110);
                    typeof(NotifyIcon).GetMethod("ShowContextMenu",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(notification,null);Application.DoEvents();
                    check(tray.Menu.Visible&&tray.Menu.Location==TrayMenu.Position(click,tray.Menu.Size,area),"native notification menu entry reopens at the captured screen click instead of a stale origin");
                    tray.Menu.Close();
                }
            }
        }
        [StructLayout(LayoutKind.Sequential)]struct Rect {public int L,T,R,B;internal Rectangle Value{get{return Rectangle.FromLTRB(L,T,R,B);}}}
        [StructLayout(LayoutKind.Sequential)]struct Monitor {public int Size;public Rect Bounds,Work;public int Flags;}
        delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,ref Rect rect,IntPtr data);
        [DllImport("user32.dll")]static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr rect,MonitorCallback callback,IntPtr data);
        [DllImport("user32.dll")]static extern bool GetMonitorInfo(IntPtr monitor,ref Monitor info);
        [DllImport("user32.dll")]static extern bool PostMessage(IntPtr window,int message,IntPtr w,IntPtr l);
        [DllImport("user32.dll")]static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
        [DllImport("user32.dll")]static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
        static bool PerMonitor(Control control){return TrayDisplay.Context==IntPtr.Zero||GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(control.Handle))==2;}
        static void MixedDisplays(Action<bool,string> check){
            var areas=new System.Collections.Generic.List<Rectangle>();
            using(var scope=new TrayDisplay.Scope())EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr dc,ref Rect rect,IntPtr data){var info=new Monitor{Size=Marshal.SizeOf(typeof(Monitor))};if(GetMonitorInfo(monitor,ref info)){if((info.Flags&1)!=0)areas.Insert(0,info.Work.Value);else areas.Add(info.Work.Value);}return true;},IntPtr.Zero);
            if(areas.Count==0)areas.Add(Screen.PrimaryScreen.WorkingArea);
            Point click=new Point(areas[0].Right-180,areas[0].Bottom-130);bool positioned=true,independent=true,preserved=true,submenu=true;string failures="";
            IntPtr original=TrayDisplay.Context;
            using(var form=new Manager(true,trayPositionOverride:()=>click)){
                form.Show();Application.DoEvents();
                var notification=(NotifyIcon)typeof(Manager).GetField("tray",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(form);notification.Visible=true;
                var window=(NativeWindow)typeof(NotifyIcon).GetField("window",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(notification);
                foreach(var area in areas)foreach(int state in new[]{0,1,2}){
                    form.RestoreManager();TrayDisplay.Move(form,new Point(area.Left+100,area.Top+70));
                    if(state==1)form.WindowState=FormWindowState.Minimized;else if(state==2)form.HideToTray();Application.DoEvents();
                    var expectedState=form.WindowState;bool expectedVisible=form.Visible;
                    PostMessage(window.Handle,0x800,IntPtr.Zero,new IntPtr(0x205));Application.DoEvents();Application.DoEvents();
                    var tray=form.TrayCommands;Rectangle bounds=TrayDisplay.Bounds(tray.Menu);
                    positioned&=tray.Menu.Visible&&bounds.Location==TrayMenu.Position(click,bounds.Size,TrayDisplay.WorkingArea(click));
                    var owner=tray.Menu.SourceControl;independent&=owner!=null&&owner!=form&&!owner.Visible&&!tray.ActivationMenu.Visible&&PerMonitor(owner)&&PerMonitor(tray.Menu);
                    bool valid=form.Visible==expectedVisible&&form.WindowState==expectedState&&(expectedState==FormWindowState.Minimized||form.LayoutFits());preserved&=valid;
                    if(!valid)failures+=" state="+state+" area="+area+" visible="+form.Visible+" expectedVisible="+expectedVisible+" window="+form.WindowState+" expectedWindow="+expectedState+" fits="+form.LayoutFits();
                    var row=tray.Targets.Values.First();using(var scope=new TrayDisplay.Scope())row.ShowDropDown();Application.DoEvents();Rectangle child=TrayDisplay.Bounds(row.DropDown);
                    submenu&=row.DropDown.Visible&&PerMonitor(row.DropDown)&&Math.Abs(child.Top-bounds.Top)<bounds.Height&&(Math.Abs(child.Left-bounds.Right)<8||Math.Abs(child.Right-bounds.Left)<8);
                    tray.Menu.Close();Application.DoEvents();
                }
            }
            check(positioned,"real queued tray notifications anchor physical pixels with the main window shown minimized or hidden on every attached monitor");
            check(independent,"notification activation never shows its temporary menu and the popup uses an independent invisible owner");
            check(preserved&&TrayDisplay.Context==original,"tray activation preserves main window visibility layout and original DPI awareness: "+failures+" context="+TrayDisplay.Context+" original="+original);
            check(submenu,"native cloud submenus stay adjacent across mixed display scaling and main window states");
            // Cards laid out for a minimized window's empty client area had to be rebuilt before the
            // restored window could paint, and it showed black meanwhile.
            using(var form=new Manager(true)){
                form.Show();Application.DoEvents();
                var card=form.Cards.Values.First();int width=card.Width;
                form.WindowState=FormWindowState.Minimized;Application.DoEvents();
                bool held=form.LayoutHeld&&card.Width==width;
                form.RestoreManager();Application.DoEvents();
                check(held&&!form.LayoutHeld&&form.LayoutFits(),"minimizing keeps the card layout and restoring resumes it");
            }
        }
    }
}
