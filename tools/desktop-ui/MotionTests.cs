using System;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace CMCP {
    internal static class MotionTests {
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,IntPtr lParam);
        static void Settle(Manager form){
            for(int i=0;i<400&&form.Transition!=null;i++){Application.DoEvents();Thread.Sleep(5);}
            Application.DoEvents();
        }
        static bool Overlaid(Manager form){return form.Controls.OfType<SnapshotOverlay>().Any()||form.ContentControls.OfType<SnapshotOverlay>().Any();}
        static bool Same(Bitmap a,Bitmap b){
            if(a.Size!=b.Size)return false;
            for(int y=3;y<a.Height;y+=23)for(int x=3;x<a.Width;x+=37)if(a.GetPixel(x,y).ToArgb()!=b.GetPixel(x,y).ToArgb())return false;
            return true;
        }
        static bool SameRow(Bitmap a,int rowA,Bitmap b,int rowB){
            for(int x=3;x<a.Width;x+=17)if(a.GetPixel(x,rowA).ToArgb()!=b.GetPixel(x,rowB).ToArgb())return false;
            return true;
        }
        static bool NothingOverlaps(Control sheet){
            var parts=sheet.Controls.Cast<Control>().Where(c=>c.Visible).ToList();
            return !parts.Any(a=>parts.Any(b=>a!=b&&a.Bounds.IntersectsWith(b.Bounds)))&&parts.All(c=>c.Bottom<=sheet.Height);
        }
        static Control Deepest(Control control){var box=control as ContainerControl;return box!=null&&box.ActiveControl!=null?Deepest(box.ActiveControl):control;}

        internal static void Run(string directory,Action<bool,string> check){
            check(Motion.EaseOut(0)==0&&Motion.EaseOut(1)==1&&Motion.EaseOut(.25)<Motion.EaseOut(.75)&&Motion.EaseOut(.5)>.5,"motion eases out and stays within its range");
            check(Motion.Mix(Color.Black,Color.White,0).ToArgb()==Color.Black.ToArgb()&&Motion.Mix(Color.Black,Color.White,1).ToArgb()==Color.White.ToArgb(),"colour fades start and end on the exact colours");
            check(!Motion.Enabled,"automated runs see final states with no animation");
            using(var form=new Manager(true)){
                form.ClientSize=new Size(1100,720);form.Show();Application.DoEvents();
                form.OpenSettings();check(form.Settings!=null&&form.Transition==null&&!Overlaid(form),"with motion off, pages change directly");
                {
                    var page=form.Settings;var sheet=page.Viewport.Controls[0];
                    check(NothingOverlaps(sheet),"general settings controls do not cover each other");
                    var groups=sheet.Controls.OfType<RoundedSheet>().ToList();
                    check(groups.Count==1&&groups.All(g=>g.Controls.OfType<ModernButton>().All(b=>b.Top>=0&&b.Bottom<=g.Height&&b.Left>=0&&b.Right<=g.Width)),"each option group holds its buttons fully inside its frame");
                    check(groups.All(g=>g.Controls.OfType<ModernButton>().Count(b=>b.Selected)==1),"each option group marks exactly one choice");
                    var options=groups[0].Controls.OfType<ModernButton>().ToList();
                    options[1].PerformClick();check(form.Options.theme=="light"&&options[1].Selected&&!options[0].Selected,"choosing an option saves it and moves the selection");
                    options[0].PerformClick();check(form.Options.theme=="system"&&options[0].Selected,"choosing the first option again restores it");
                    check(sheet.Controls.OfType<ToggleSwitch>().Count()==2,"startup and closing behaviour are switches");
                    var language=sheet.Controls.OfType<DropdownField>().First();
                    check(language.Choose("en")&&form.Options.language=="en"&&language.Value=="en","choosing a language saves it");
                    check(language.Choose("zh-CN")&&form.Options.language=="zh-CN"&&!language.Choose("zh-CN"),"choosing the current language does nothing");
                    var inside=language.PointToScreen(new Point(5,5));
                    check(language.Arrow=="chevron"&&!language.IsOpen,"a closed dropdown points down");
                    language.TestClick();check(language.IsOpen&&language.Arrow=="up","the first click opens the dropdown and points the arrow up");
                    check(!language.Menu.ShowCheckMargin&&!language.Menu.ShowImageMargin&&language.Menu.Items.OfType<ToolStripMenuItem>().All(i=>!i.Checked),"dropdown items have no check box");
                    language.Menu.Close(ToolStripDropDownCloseReason.AppClicked);language.NoteClosing(ToolStripDropDownCloseReason.AppClicked,inside);language.TestClick();
                    check(!language.IsOpen&&language.Arrow=="chevron","a second click on the field closes the dropdown and stays closed");
                    language.TestClick();check(language.IsOpen,"the next click opens it again");
                    language.Menu.Close(ToolStripDropDownCloseReason.AppClicked);language.NoteClosing(ToolStripDropDownCloseReason.AppClicked,new Point(-5000,-5000));language.TestClick();
                    check(language.IsOpen,"closing by clicking elsewhere does not block the next click on the field");
                    language.Menu.Close(ToolStripDropDownCloseReason.ItemClicked);Application.DoEvents();
                    page.ShowConnect();check(NothingOverlaps(page.Viewport.Controls[0])&&page.ConnectTab.Selected&&!page.GeneralTab.Selected,"connection page controls do not cover each other");
                    page.ShowAbout();check(NothingOverlaps(page.Viewport.Controls[0]),"about page controls do not cover each other");
                }
                form.CloseSettings();
                Motion.Forced=true;
                try{
                    using(var before=SnapshotOverlay.CaptureClient(form)){
                        form.OpenSettings();
                        check(form.Settings!=null&&form.Transition!=null,"a page is already in place while its transition plays");
                        using(var start=form.Transition.RenderAt(0))check(Same(start,before),"a page transition starts on the exact old page");
                        using(var end=form.Transition.RenderAt(1))using(var page=SnapshotOverlay.CaptureClient(form))check(Same(end,page),"a page transition ends on the exact new page");
                    }
                    Settle(form);
                    check(form.Transition==null&&!Overlaid(form)&&form.Settings.Visible,"opening settings removes its overlay and leaves the real page");
                    form.CloseSettings();check(form.Settings==null&&form.Transition!=null,"closing settings also plays a transition");
                    form.OpenSettings();check(form.Settings!=null&&form.Controls.OfType<SnapshotOverlay>().Count()==1,"a new page during a transition finishes the old one first");
                    Settle(form);form.CloseSettings();Settle(form);
                    check(form.Settings==null&&!Overlaid(form)&&form.ScrollOffset>=0,"rapid page changes leave no overlay behind");

                    form.OpenSettings();SendMessage(form.Transition.Handle,0x201,new IntPtr(1),new IntPtr((10<<16)|10));Application.DoEvents();
                    check(form.Transition==null&&!Overlaid(form),"pressing the mouse during a transition finishes it");
                    form.CloseSettings();Settle(form);

                    form.OpenSettings();Settle(form);var tabs=form.Settings;
                    tabs.AboutTab.PerformClick();
                    check(form.Transition!=null&&form.Transition.Parent==tabs&&form.Transition.Bounds==tabs.Viewport.Bounds,"switching settings tabs animates only the content below the tabs");
                    check(tabs.AboutTab.Selected&&!tabs.GeneralTab.Selected,"the chosen tab is marked at once");
                    using(var end=form.Transition.RenderAt(1))using(var content=SnapshotOverlay.Snapshot(tabs.Viewport))check(Same(end,content),"a tab change ends on the exact new content");
                    Settle(form);check(form.Transition==null&&!tabs.Controls.OfType<SnapshotOverlay>().Any(),"a tab change removes its overlay");
                    tabs.AboutTab.PerformClick();check(form.Transition==null,"choosing the current tab does nothing");
                    tabs.GeneralTab.PerformClick();Settle(form);
                    var toggle=tabs.Viewport.Controls[0].Controls.OfType<ToggleSwitch>().First();bool wasOn=toggle.Checked;
                    toggle.Checked=!wasOn;check(toggle.Level>0&&toggle.Level<1||toggle.Level==(wasOn?1:0),"the switch slides instead of jumping");
                    for(int i=0;i<200&&toggle.Level!=(wasOn?0:1);i++){Application.DoEvents();Thread.Sleep(5);}
                    check(toggle.Level==(wasOn?0:1),"the switch settles on its new position");
                    toggle.Checked=wasOn;
                    var field=tabs.Viewport.Controls[0].Controls.OfType<DropdownField>().First();
                    Action settleMenu=()=>{for(int i=0;i<200&&field.Animating;i++){Application.DoEvents();Thread.Sleep(5);}};
                    field.TestClick();check(field.IsOpen&&field.Animating&&field.Menu.Region!=null,"opening the dropdown unfolds it");
                    check(field.Menu.Items.Cast<ToolStripItem>().Count(i=>Equals(i.Tag,true))==1,"exactly one language is marked as current");
                    settleMenu();check(field.IsOpen&&!field.Animating&&field.Menu.Opacity==1&&field.Menu.Region!=null&&field.Menu.Region.IsVisible(field.Menu.Width/2,field.Menu.Height-2)&&!field.Menu.Region.IsVisible(0,0),"the dropdown ends fully shown with rounded corners");
                    field.TestClick();check(!field.IsOpen&&field.Animating&&field.Menu.Visible,"closing folds it away while still on screen");
                    settleMenu();check(!field.Menu.Visible&&!field.Animating,"the dropdown is gone after folding away");
                    field.TestClick();field.TestClick();field.TestClick();check(field.IsOpen,"a click during the fold reopens it");
                    settleMenu();field.TestClick();settleMenu();
                    form.CloseSettings();Settle(form);

                    var a=form.Cards.Values.First();var b=form.Cards.Values.Skip(1).First();
                    string previousAddress=b.Address;form.SwitchLogin(b);
                    check(form.Transition!=null&&b.Address!=previousAddress,"switching sign-in uses the existing fade transition with the final address already applied");Settle(form);
                    check(form.Transition==null&&b.SshActive,"the sign-in transition finishes on the selected SSH mode");form.SwitchLogin(b);Settle(form);
                    form.OpenEditor(a.Target.Name);check(form.Editor!=null&&form.Transition!=null,"opening the editor plays a transition");Settle(form);
                    check(Deepest(form)==form&&!form.Editor.NameInput.Box.Focused,"opening the editor leaves its fields unfocused through the transition");
                    form.CloseEditor();Settle(form);check(form.Editor==null&&!Overlaid(form),"closing the editor removes its overlay");

                    a.SetExpanded(false,false);Application.DoEvents();
                    int collapsed=a.Bottom;
                    using(var before=SnapshotOverlay.Snapshot(form.list)){
                        a.Toggle.PerformClick();
                        check(a.Expanded&&a.Height==a.FinalHeight&&b.Top>=a.Bottom&&form.Transition!=null,"expanding lays the cards out at once and animates a picture of them");
                        int expanded=a.Bottom;
                        using(var end=form.Transition.RenderAt(1))using(var list=SnapshotOverlay.Snapshot(form.list))check(Same(end,list),"expanding ends on the exact final layout");
                        int cut=form.Transition.RevealCut(.3);
                        check(cut>collapsed&&cut<expanded,"the card grows between its two heights");
                        using(var middle=form.Transition.RenderAt(.3))check(SameRow(middle,cut+8,before,collapsed+8),"cards below move with the growing card");
                    }
                    Settle(form);check(form.Transition==null&&!Overlaid(form)&&a.Details.Visible,"expanding removes its overlay");
                    a.Toggle.PerformClick();check(!a.Expanded&&a.Height==a.FinalHeight&&form.Transition!=null,"collapsing lays the cards out at once and animates a picture of them");
                    using(var end=form.Transition.RenderAt(1))using(var list=SnapshotOverlay.Snapshot(form.list))check(Same(end,list),"collapsing ends on the exact final layout");
                    Settle(form);check(form.Transition==null&&!a.Details.Visible,"collapsing removes its overlay");

                    a.Toggle.PerformClick();form.ClientSize=new Size(1000,640);Application.DoEvents();
                    check(form.Transition==null&&!Overlaid(form)&&a.Height==a.FinalHeight,"resizing the window ends a transition at once");
                    a.SetExpanded(false,false);
                    a.Toggle.PerformClick();form.HideToTray();check(form.Transition==null&&!Overlaid(form),"hiding the window ends a transition at once");
                }finally{Motion.Forced=false;}
            }
            using(var form=new Manager(true)){
                form.Show();Application.DoEvents();
                check(!form.toolbar.Settings.Dot,"no dot shows before a new version is found");
                form.SimulateUpdate("9.9.9");check(form.toolbar.Settings.Dot,"a new version puts a dot on the settings button");
                form.OpenSettings();Application.DoEvents();check(form.Settings.AboutTab.Dot&&!form.Settings.GeneralTab.Dot,"the dot leads to the About category");
                form.Settings.ShowAbout();Application.DoEvents();var about=form.Settings.Viewport.Controls[0];
                check(about.Controls.OfType<ModernButton>().Any(b=>b.Text=="立即更新")&&about.Controls.OfType<Label>().Any(l=>l.Text.Contains("9.9.9")),"About offers the update and names the version");
                check(NothingOverlaps(about),"the update offer does not cover other rows");
            }
        }
    }
}
