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
        static Control Deepest(Control control){var box=control as ContainerControl;return box!=null&&box.ActiveControl!=null?Deepest(box.ActiveControl):control;}

        internal static void Run(string directory,Action<bool,string> check){
            check(Motion.EaseOut(0)==0&&Motion.EaseOut(1)==1&&Motion.EaseOut(.25)<Motion.EaseOut(.75)&&Motion.EaseOut(.5)>.5,"motion eases out and stays within its range");
            check(Motion.Mix(Color.Black,Color.White,0).ToArgb()==Color.Black.ToArgb()&&Motion.Mix(Color.Black,Color.White,1).ToArgb()==Color.White.ToArgb(),"colour fades start and end on the exact colours");
            check(!Motion.Enabled,"automated runs see final states with no animation");
            using(var form=new Manager(true)){
                form.ClientSize=new Size(1100,720);form.Show();Application.DoEvents();
                form.OpenSettings();check(form.Settings!=null&&form.Transition==null&&!Overlaid(form),"with motion off, pages change directly");
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

                    var a=form.Cards.Values.First();var b=form.Cards.Values.Skip(1).First();
                    form.OpenEditor(a.Target.Name);check(form.Editor!=null&&form.Transition!=null,"opening the editor plays a transition");Settle(form);
                    check(Deepest(form)==form.Editor.NameInput.Box,"the editor keeps keyboard focus through its transition");
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
        }
    }
}
