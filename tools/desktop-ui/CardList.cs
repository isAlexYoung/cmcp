using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CMCP {
    // Explicit vertical layout avoids FlowLayoutPanel's partial resize paints.
    // Sorting uses short eased translations; preferences change only on drop.
    internal sealed class CardList : EditorViewport {
        [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window,IntPtr update,IntPtr region,uint flags);
        [DllImport("user32.dll")] static extern IntPtr BeginDeferWindowPos(int count);
        [DllImport("user32.dll")] static extern IntPtr DeferWindowPos(IntPtr batch,IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
        [DllImport("user32.dll")] static extern bool EndDeferWindowPos(IntPtr batch);
        const uint MoveWithoutCopy=0x011D; // NOSIZE | NOZORDER | NOREDRAW | NOACTIVATE | NOCOPYBITS
        readonly Timer motion=new Timer{Interval=15};
        readonly Dictionary<Control,int> destinations=new Dictionary<Control,int>();
        List<TargetCard> order, original;
        Dictionary<TargetCard,int> centers;
        TargetCard dragging;
        int dragOffset,scrollOffset,contentHeight;
        internal Action WheelStarted;
        internal event Action<string,string> Sorted;
        internal bool Sorting { get { return dragging!=null; } }
        internal bool Resizing;
        internal bool Moving { get { return motion.Enabled; } }
        internal CardList():base(true){motion.Tick+=delegate{Advance();};}
        internal int MaxScrollOffset { get { return Math.Max(0,contentHeight-ClientSize.Height); } }
        internal int ScrollOffset { get { return scrollOffset; } set { StopGlide();MoveViewport(value); } }
        protected override int WheelOffset { get { return scrollOffset; } }
        protected override int WheelLimit { get { return Sorting?0:MaxScrollOffset; } }
        protected override bool AnimateWheel { get { return Motion.Enabled; } }
        protected override bool CoalesceWheelInput { get { return true; } }
        protected override void BeginWheel(){
            if(WheelStarted!=null)WheelStarted();
            foreach(var card in destinations.Keys.OfType<TargetCard>())card.FinishHoverMotion();
        }
        protected override void ScrollWheelTo(int value){MoveViewport(value);}
        protected override void OnSizeChanged(EventArgs e){StopGlide();motion.Stop();base.OnSizeChanged(e);}
        protected override void OnVisibleChanged(EventArgs e){if(!Visible)StopGlide();base.OnVisibleChanged(e);}
        internal void Reveal(Control control){
            if(!Visible||control.IsDisposed)return;
            var bounds=RectangleToClient(control.RectangleToScreen(control.ClientRectangle));
            int delta=bounds.Top<0?bounds.Top:Math.Max(0,bounds.Top+Math.Min(bounds.Height,ClientSize.Height)-ClientSize.Height);
            if(delta!=0)ScrollOffset=scrollOffset+delta;
        }
        void MoveViewport(int value){
            value=Math.Max(0,Math.Min(MaxScrollOffset,value));
            int delta=value-scrollOffset;if(delta==0)return;
            scrollOffset=value;
            var cards=destinations.Keys.Where(card=>card.Parent==this).ToArray();
            var tops=cards.Select(card=>card.Top-delta).ToArray();
            // Default WinForms scrolling copies old pixels before its child HWNDs move.
            // Move the whole list in one batch, then paint the viewport and its children.
            IntPtr batch=IsHandleCreated&&Visible&&cards.All(card=>card.IsHandleCreated)?BeginDeferWindowPos(cards.Length):IntPtr.Zero;
            for(int i=0;batch!=IntPtr.Zero&&i<cards.Length;i++)
                batch=DeferWindowPos(batch,cards[i].Handle,IntPtr.Zero,cards[i].Left,tops[i],0,0,MoveWithoutCopy);
            if(batch==IntPtr.Zero||!EndDeferWindowPos(batch))
                for(int i=0;i<cards.Length;i++)cards[i].Top=tops[i];
            PaintPositions();
        }
        internal void Place(IList<TargetCard> cards,bool animate){
            if(Sorting)cards=order;
            int y=0,width=Math.Max(420,ClientSize.Width-2);
            if(!animate&&motion.Enabled){
                int expected=0;bool same=cards.Count==destinations.Count;
                foreach(var card in cards){int goal;same&=destinations.TryGetValue(card,out goal)&&goal==expected&&card.Width==width;expected+=card.Height+Palette.Gap;}
                if(same)return;
            }
            bool changed=false;
            destinations.Clear();SuspendLayout();
            try{
                foreach(var card in cards){
                    if(card.Width!=width){card.Width=width;changed=true;}
                    destinations[card]=y;
                    y+=card.Height+Palette.Gap;
                }
                contentHeight=y;
                if(scrollOffset>MaxScrollOffset){StopGlide();scrollOffset=MaxScrollOffset;animate=false;}
                if(animate&&!Resizing&&Visible)motion.Start();
                else{
                    motion.Stop();
                    foreach(var pair in destinations){
                        int top=pair.Value-scrollOffset;
                        if(pair.Key!=dragging&&pair.Key.Top!=top){pair.Key.Top=top;changed=true;}
                    }
                }
            }finally{ResumeLayout(false);}
            if(changed)Invalidate(true);
        }
        void Advance(){
            bool more=false;int scroll=-scrollOffset;
            SuspendLayout();try{foreach(var pair in destinations.ToArray()){
                if(pair.Key.IsDisposed||pair.Key.Parent!=this||pair.Key==dragging)continue;
                int goal=pair.Value+scroll,delta=goal-pair.Key.Top;
                if(delta!=0){int step=Math.Abs(delta)<3?delta:(int)Math.Ceiling(Math.Abs(delta)*.28)*Math.Sign(delta);pair.Key.Top+=step;more|=pair.Key.Top!=goal;}
            }}finally{ResumeLayout(false);}
            PaintPositions();if(!more)motion.Stop();
        }
        void PaintPositions(){
            // Mouse moves can keep WM_PAINT queued while native child windows copy
            // their old pixels across overlapping cards. Finish the parent AND
            // descendant paints before displaying the next drag/animation frame.
            if(IsHandleCreated&&Visible)RedrawWindow(Handle,IntPtr.Zero,IntPtr.Zero,0x0185); // INVALIDATE | ERASE | ALLCHILDREN | UPDATENOW
            else Invalidate(true);
        }
        internal void FinishMotion(){while(motion.Enabled)Advance();}
        internal void BeginSort(TargetCard card,int pointerY){
            StopGlide();FinishMotion();original=Controls.OfType<TargetCard>().OrderBy(c=>c.Top).ToList();order=original.ToList();
            centers=original.ToDictionary(c=>c,c=>c.Top+scrollOffset+c.Height/2);
            dragging=card;dragOffset=pointerY-card.Top;card.BringToFront();
        }
        internal void MoveSort(int pointerY){
            if(!Sorting)return;
            int top=Math.Max(-scrollOffset,Math.Min(contentHeight-dragging.Height-scrollOffset,pointerY-dragOffset));
            int center=top+scrollOffset+dragging.Height/2;
            var next=original.Where(c=>c!=dragging).ToList();int index=next.Count(c=>centers[c]<center);
            next.Insert(index,dragging);
            if(!next.SequenceEqual(order)){order=next;Place(order,true);}
            dragging.Top=top;PaintPositions();
        }
        internal void EndSort(bool commit){
            if(!Sorting)return;
            var card=dragging;var next=commit?order:original;dragging=null;
            int index=next.IndexOf(card);string before=index+1<next.Count?next[index+1].Target.Name:"";
            Place(next,true);if(commit&&Sorted!=null)Sorted(card.Target.Name,before);
        }
        protected override void Dispose(bool disposing){if(disposing){motion.Stop();motion.Dispose();}base.Dispose(disposing);}
    }
}
