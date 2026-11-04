using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace CMCP {
    internal static class Motion {
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action,uint parameter,ref bool value,uint flags);
        const uint ClientAreaAnimation=0x1042;
        // Automation and screenshots must see final states; motion tests turn it back on.
        internal static bool Suppressed,Forced;
        internal static bool Enabled { get {
            if(Forced)return true;
            if(Suppressed||SystemInformation.TerminalServerSession)return false;
            bool on=true;
            try{if(!SystemParametersInfo(ClientAreaAnimation,0,ref on,0))return true;}catch{return true;}
            return on;
        } }
        internal static double EaseOut(double t){t=Math.Max(0,Math.Min(1,t));double rest=1-t;return 1-rest*rest*rest;}
        internal static Color Mix(Color from,Color to,double t){
            t=Math.Max(0,Math.Min(1,t));
            Func<int,int,int> mix=(a,b)=>(int)Math.Round(a+(b-a)*t);
            return Color.FromArgb(mix(from.A,to.A),mix(from.R,to.R),mix(from.G,to.G),mix(from.B,to.B));
        }
    }

    // Frames follow the display's refresh instead of a 15 ms WinForms timer, which runs
    // at the lowest message priority and cannot keep pace with a high refresh rate.
    internal sealed class FrameClock {
        [DllImport("dwmapi.dll")] static extern int DwmFlush();
        readonly Control owner;
        readonly Action frame;
        volatile bool stopped;
        int pending;
        internal FrameClock(Control owner,Action frame){this.owner=owner;this.frame=frame;}
        internal void Start(){new Thread(Run){IsBackground=true,Name="CMCP frame clock"}.Start();}
        internal void Stop(){stopped=true;}
        void Run(){
            var pace=Stopwatch.StartNew();
            while(!stopped){
                long before=pace.ElapsedMilliseconds;
                bool synced;try{synced=DwmFlush()==0;}catch{synced=false;}
                // DwmFlush can return at once when nothing is being composed.
                if(!synced||pace.ElapsedMilliseconds-before<2)Thread.Sleep(8);
                if(stopped)return;
                if(Interlocked.CompareExchange(ref pending,1,0)!=0)continue;
                try{owner.BeginInvoke(new Action(Deliver));}catch(InvalidOperationException){return;}
            }
        }
        void Deliver(){Interlocked.Exchange(ref pending,0);if(!stopped)frame();}
    }

    // Plays a transition from pictures of the old and new state, so its cost does not
    // depend on how many controls a page has. The real controls are already in their
    // final state underneath; this control only covers them until the last frame.
    internal sealed class SnapshotOverlay : Control {
        [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr target,int x,int y,int width,int height,IntPtr source,int sourceX,int sourceY,uint operation);
        [DllImport("msimg32.dll")] static extern bool AlphaBlend(IntPtr target,int x,int y,int width,int height,IntPtr source,int sourceX,int sourceY,int sourceWidth,int sourceHeight,int blend);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc,IntPtr value);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,IntPtr lParam);
        [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window,IntPtr rectangle,IntPtr region,uint flags);
        const uint SourceCopy=0x00CC0020,RedrawAll=0x185;
        const int SetRedraw=0x0B,PageMilliseconds=180,RevealMilliseconds=170,PageSlide=20,CardEdge=14;

        sealed class Surface : IDisposable {
            internal readonly IntPtr Dc;
            readonly IntPtr handle,previous;
            internal Surface(Bitmap picture){handle=picture.GetHbitmap();Dc=CreateCompatibleDC(IntPtr.Zero);previous=SelectObject(Dc,handle);}
            public void Dispose(){SelectObject(Dc,previous);DeleteDC(Dc);DeleteObject(handle);}
        }

        readonly Stopwatch elapsed=new Stopwatch();
        Surface first,last,back;
        FrameClock clock;
        Control host;
        double duration=1,progress;
        bool reveal,expanding,finished;
        int direction,collapsedBottom,expandedBottom;
        internal event Action Finished;

        internal static Bitmap Snapshot(Control control){
            var picture=new Bitmap(Math.Max(1,control.Width),Math.Max(1,control.Height),PixelFormat.Format32bppRgb);
            control.DrawToBitmap(picture,new Rectangle(Point.Empty,control.Size));
            return picture;
        }
        internal static Bitmap CaptureClient(Form form){
            var picture=new Bitmap(Math.Max(1,form.ClientSize.Width),Math.Max(1,form.ClientSize.Height),PixelFormat.Format32bppRgb);
            using(var g=Graphics.FromImage(picture))g.Clear(form.BackColor);
            foreach(var child in form.Controls.Cast<Control>().Reverse())if(child.Visible&&!(child is SnapshotOverlay))child.DrawToBitmap(picture,child.Bounds);
            return picture;
        }

        internal SnapshotOverlay(Bitmap still,Rectangle bounds){
            SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.Opaque,true);
            SetStyle(ControlStyles.Selectable,false);TabStop=false;Bounds=bounds;
            using(still){first=new Surface(still);}
            using(var buffer=new Bitmap(Math.Max(1,Width),Math.Max(1,Height),PixelFormat.Format32bppRgb))back=new Surface(buffer);
        }
        protected override void OnParentChanged(EventArgs e){
            base.OnParentChanged(e);if(host!=null)host.SizeChanged-=HostResized;
            host=Parent;if(host!=null)host.SizeChanged+=HostResized;
        }
        void HostResized(object sender,EventArgs e){Finish();}
        internal void PlayFade(Bitmap next,int slideDirection){direction=slideDirection;Play(next,PageMilliseconds);}
        internal void PlayReveal(Bitmap next,bool expand,int bottomCollapsed,int bottomExpanded){
            reveal=true;expanding=expand;collapsedBottom=bottomCollapsed;expandedBottom=bottomExpanded;Play(next,RevealMilliseconds);
        }
        void Play(Bitmap next,int milliseconds){
            using(next){last=new Surface(next);}
            duration=milliseconds;elapsed.Restart();
            clock=new FrameClock(this,Frame);clock.Start();
        }
        void Frame(){
            if(finished)return;
            progress=elapsed.ElapsedMilliseconds/duration;
            if(progress>=1){Finish();return;}
            Invalidate();Update();
        }
        internal int RevealCut(double t){
            double eased=Motion.EaseOut(t);
            return collapsedBottom+(int)Math.Round((expandedBottom-collapsedBottom)*(expanding?eased:1-eased));
        }
        static void Copy(IntPtr target,int y,int width,int height,IntPtr source,int sourceY,int limit){
            height=Math.Min(height,Math.Min(limit-y,limit-sourceY));
            if(height>0)BitBlt(target,0,y,width,height,source,0,sourceY,SourceCopy);
        }
        void Compose(double t){
            int w=Width,h=Height;
            if(last==null){BitBlt(back.Dc,0,0,w,h,first.Dc,0,0,SourceCopy);return;}
            if(!reveal){
                double eased=Motion.EaseOut(t);
                BitBlt(back.Dc,0,0,w,h,first.Dc,0,0,SourceCopy);
                int offset=direction*(int)Math.Round((1-eased)*PageSlide),visible=w-Math.Abs(offset);
                int alpha=(int)Math.Round(eased*255);
                // BLENDFUNCTION: source over, constant alpha.
                if(alpha>0&&visible>0)AlphaBlend(back.Dc,Math.Max(0,offset),0,visible,h,last.Dc,Math.Max(0,-offset),0,visible,h,alpha<<16);
                return;
            }
            // The card grows from its collapsed to its expanded bottom: header from the final
            // state, details from the expanded picture, then the card's own rounded bottom
            // edge, then whatever follows the card from the collapsed picture.
            var expanded=expanding?last:first;var collapsed=expanding?first:last;
            int cut=RevealCut(t),edge=cut-CardEdge,headerEnd=collapsedBottom-CardEdge;
            Copy(back.Dc,0,w,headerEnd,last.Dc,0,h);
            Copy(back.Dc,headerEnd,w,edge-headerEnd,expanded.Dc,headerEnd,h);
            Copy(back.Dc,edge,w,CardEdge,expanded.Dc,expandedBottom<=h?expandedBottom-CardEdge:edge,h);
            Copy(back.Dc,cut,w,h-cut,collapsed.Dc,collapsedBottom,h);
        }
        internal Bitmap RenderAt(double t){
            Compose(t);
            var picture=new Bitmap(Width,Height,PixelFormat.Format32bppRgb);
            using(var g=Graphics.FromImage(picture)){IntPtr dc=g.GetHdc();try{BitBlt(dc,0,0,Width,Height,back.Dc,0,0,SourceCopy);}finally{g.ReleaseHdc(dc);}}
            return picture;
        }
        protected override void OnPaint(PaintEventArgs e){
            if(finished)return;
            Compose(progress);
            IntPtr dc=e.Graphics.GetHdc();try{BitBlt(dc,0,0,Width,Height,back.Dc,0,0,SourceCopy);}finally{e.Graphics.ReleaseHdc(dc);}
        }
        // Finishing now, rather than dropping the click, means no click waits on an animation.
        protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);if(IsHandleCreated)BeginInvoke(new Action(Finish));}
        internal void Finish(){
            if(finished)return;
            finished=true;if(clock!=null)clock.Stop();
            var parent=Parent;
            if(parent!=null&&parent.IsHandleCreated&&!parent.IsDisposed){
                // Uncover in one step, so the real controls paint together rather than one by one.
                SendMessage(parent.Handle,SetRedraw,IntPtr.Zero,IntPtr.Zero);
                try{parent.Controls.Remove(this);}
                finally{SendMessage(parent.Handle,SetRedraw,new IntPtr(1),IntPtr.Zero);RedrawWindow(parent.Handle,IntPtr.Zero,IntPtr.Zero,RedrawAll);}
            }else if(parent!=null)parent.Controls.Remove(this);
            if(Finished!=null)Finished();
            Dispose();
        }
        protected override void Dispose(bool disposing){
            if(disposing){
                finished=true;if(clock!=null)clock.Stop();
                if(host!=null){host.SizeChanged-=HostResized;host=null;}
                foreach(var surface in new[]{first,last,back})if(surface!=null)surface.Dispose();
                first=last=back=null;
            }
            base.Dispose(disposing);
        }
    }
}
