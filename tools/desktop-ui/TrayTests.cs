using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    internal static class TrayTests {
        internal static void Capture(string path,bool dark){
            L.Set("zh-CN");using(var host=new Form{ClientSize=new Size(680,320)})using(var menu=new TrayMenu(delegate{},delegate{},delegate{},delegate{},()=>dark)){
                host.Show();menu.Sync(new[]{new TrayTarget{Name="A",Label="工作电脑",State="已连接",CanDisconnect=true,CanRename=true},new TrayTarget{Name="B",Label="desktop.example.com",State="已停止",CanConnect=true,CanRename=true}});
                menu.Menu.Show(host,new Point(30,50));var item=menu.Targets["A"];item.Select();item.ShowDropDown();Application.DoEvents();
                Rectangle area=Rectangle.Union(menu.Menu.Bounds,item.DropDown.Bounds);using(var bitmap=new Bitmap(area.Width+8,area.Height+8)){
                    using(var graphics=Graphics.FromImage(bitmap))graphics.Clear(Palette.Create(dark).Page);
                    menu.Menu.DrawToBitmap(bitmap,new Rectangle(menu.Menu.Left-area.Left+4,menu.Menu.Top-area.Top+4,menu.Menu.Width,menu.Menu.Height));
                    item.DropDown.DrawToBitmap(bitmap,new Rectangle(item.DropDown.Left-area.Left+4,item.DropDown.Top-area.Top+4,item.DropDown.Width,item.DropDown.Height));
                    bitmap.Save(Path.GetFullPath(path),System.Drawing.Imaging.ImageFormat.Png);
                }
                menu.Menu.Close();
            }
        }
        internal static void Run(string directory,Action<bool,string> check){
            using(var form=new Manager(true)){
                form.Show();Application.DoEvents();var menu=form.TrayCommands;
                check(form.TrayVisible&&form.Visible&&menu.Targets.Count==2,"launch keeps a resident tray icon alongside the visible main window");
                check(form.Options.theme=="system"&&form.Preferences.dark==AppSettings.SystemDark(false,false),"main window defaults to the current system app theme");
                var a=menu.Targets["preview-a"];var b=menu.Targets["preview-b"];
                check(a.Text=="desktop1.example.com · 已连接"&&b.Text=="desktop2.example.com · 已停止","tray lists every cloud hostname and current connection state");
                check(a.DropDownItems.Cast<ToolStripItem>().Select(i=>i.Text).SequenceEqual(new[]{"连接云电脑","断开云电脑","重命名"}),"hoverable cloud row provides exactly three target actions");
                check(!a.DropDownItems[0].Enabled&&a.DropDownItems[1].Enabled&&b.DropDownItems[0].Enabled&&!b.DropDownItems[1].Enabled,"tray connect and disconnect availability follows each cloud state");
                form.HideToTray();b.DropDownItems[0].PerformClick();
                check(!form.Visible&&form.TrayVisible&&form.Cards["preview-b"].Target.State=="connected"&&form.Cards["preview-a"].Target.State=="connected","tray connects only selected cloud without opening or hiding the resident icon");
                b.DropDownItems[1].PerformClick();check(form.Cards["preview-b"].Target.State=="stopped"&&form.Cards["preview-a"].Target.State=="connected","tray disconnect preserves the other cloud connection");
                var targets=form.Cards.Values.Select(c=>c.Target).ToList();form.Preferences.Set("preview-b","研发 & 测试","",targets);form.Cards["preview-b"].UpdatePreference(form.Preferences.Get("preview-b"));form.RefreshState();
                check(b.Text=="研发 && 测试 · 已停止"&&b.ToolTipText=="研发 & 测试 · 已停止","tray prefers remarks and escapes menu mnemonic characters");
                form.RestoreManager();menu.Menu.Show(form,new Point(30,70));b.ShowDropDown();Application.DoEvents();
                form.Cards["preview-b"].Target.State="offline";form.RefreshState();Application.DoEvents();
                check(menu.Menu.Visible&&b.DropDown.Visible&&Object.ReferenceEquals(b,menu.Targets["preview-b"])&&b.Text.Contains("等待网络恢复"),"live status refresh preserves the open tray menu and cloud submenu");
                menu.Menu.Close();var next=form.Options.Copy();next.language="en";form.ChangeSettings(next);
                check(menu.Targets["preview-b"].Text.Contains("Waiting for network")&&b.DropDownItems.Cast<ToolStripItem>().Select(i=>i.Text).SequenceEqual(new[]{"Connect cloud PC","Disconnect cloud PC","Rename"}),"tray captions and actions follow the selected interface language");
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
                menu.Sync(new TrayTarget[0]);check(menu.Targets.Count==0&&menu.Menu.Items.OfType<ToolStripMenuItem>().Any(i=>i.Text=="暂无云电脑"&&!i.Enabled),"empty tray has a disabled no-cloud hint and preserves application actions");
                var values=Enumerable.Range(0,100).Select(i=>new TrayTarget{Name="id-"+i,Label="Same note",State="已停止",CanConnect=true,CanRename=true}).ToList();menu.Sync(values);
                check(menu.Targets.Count==100&&menu.Menu.Items.Count==104,"tray includes all one hundred supported clouds without a fixed entry cap");
                menu.Targets["id-73"].DropDownItems[0].PerformClick();check(invoked=="id-73:connect","duplicate remarks still dispatch using the immutable cloud identity");
                dark=true;menu.ApplySystemTheme();check(menu.Colors.Dark&&menu.Menu.BackColor==Palette.Create(true).Surface&&menu.Targets["id-73"].DropDown.BackColor==menu.Menu.BackColor,"root and nested tray menus follow dark system colors independently of app theme");
                dark=false;menu.ApplySystemTheme();check(!menu.Colors.Dark&&menu.Menu.ForeColor==Palette.Create(false).Text,"tray reacts to switching the system back to light colors");
                menu.Sync(values.Take(1).ToList());check(menu.Targets.Count==1&&menu.Targets.ContainsKey("id-0")&&menu.Menu.Items.Count==5,"removed cloud rows disappear without leaving stale tray commands");
            }
            string state=Path.Combine(directory,"tray-defaults");Directory.CreateDirectory(state);
            try{
                File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"theme\":\"\"}");check(AppSettings.Load(state).theme=="system","legacy unspecified theme migrates to following the system");
                File.WriteAllText(AppSettings.PathFor(state),"{\"schema\":1,\"theme\":\"dark\"}");check(AppSettings.Load(state).theme=="dark","explicit user theme choice is retained across the tray update");
            }finally{File.Delete(AppSettings.PathFor(state));Directory.Delete(state,false);}
        }
    }
}
