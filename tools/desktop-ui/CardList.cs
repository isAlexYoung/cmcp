using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    // Explicit vertical layout avoids FlowLayoutPanel's partial resize paints.
    // Sorting uses short eased translations; preferences change only on drop.
    internal sealed class CardList : EditorViewport {
        readonly Timer motion=new Timer{Interval=15};
        readonly Dictionary<Control,int> destinations=new Dictionary<Control,int>();
        List<TargetCard> order, original;
        Dictionary<TargetCard,int> centers;
        TargetCard dragging;
        int offset;
        internal event Action<string,string> Sorted;
        internal bool Sorting { get { return dragging!=null; } }
        internal bool Resizing;
        internal bool Moving { get { return motion.Enabled; } }
        internal CardList(){AutoScroll=true;DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw|ControlStyles.AllPaintingInWmPaint,true);motion.Tick+=delegate{Advance();};}
        protected override void OnSizeChanged(EventArgs e){motion.Stop();destinations.Clear();base.OnSizeChanged(e);Invalidate(true);}
        internal void Place(IList<TargetCard> cards,bool animate){
            if(Sorting)cards=order;
            int y=0,scroll=AutoScrollPosition.Y,width=Math.Max(420,ClientSize.Width-2);
            if(!animate&&motion.Enabled){
                int expected=0;bool same=cards.Count==destinations.Count;
                foreach(var card in cards){int goal;same&=destinations.TryGetValue(card,out goal)&&goal==expected&&card.Width==width;expected+=card.Height+Palette.Gap;}
                if(same)return;
            }
            destinations.Clear();SuspendLayout();
            try{foreach(var card in cards){
                card.Width=width;card.PerformLayout();
                destinations[card]=y;
                if(card!=dragging&&(!animate||Resizing||!Visible))card.Location=new Point(0,y+scroll);
                y+=card.Height+Palette.Gap;
            }
            AutoScrollMinSize=new Size(0,y);
            }finally{ResumeLayout(false);}
            if(animate&&!Resizing&&Visible)motion.Start();else motion.Stop();
            Invalidate(true);
        }
        void Advance(){
            bool more=false;int scroll=AutoScrollPosition.Y;
            SuspendLayout();try{foreach(var pair in destinations.ToArray()){
                if(pair.Key.IsDisposed||pair.Key.Parent!=this||pair.Key==dragging)continue;
                int goal=pair.Value+scroll,delta=goal-pair.Key.Top;
                if(delta!=0){int step=Math.Abs(delta)<3?delta:(int)Math.Ceiling(Math.Abs(delta)*.28)*Math.Sign(delta);pair.Key.Top+=step;more|=pair.Key.Top!=goal;}
            }}finally{ResumeLayout(false);}
            Invalidate(true);if(!more)motion.Stop();
        }
        internal void FinishMotion(){while(motion.Enabled)Advance();}
        internal void BeginSort(TargetCard card,int pointerY){
            FinishMotion();original=Controls.OfType<TargetCard>().OrderBy(c=>c.Top).ToList();order=original.ToList();
            centers=original.ToDictionary(c=>c,c=>c.Top-AutoScrollPosition.Y+c.Height/2);
            dragging=card;offset=pointerY-card.Top;card.BringToFront();
        }
        internal void MoveSort(int pointerY){
            if(!Sorting)return;
            int top=Math.Max(AutoScrollPosition.Y,Math.Min(AutoScrollMinSize.Height-dragging.Height+AutoScrollPosition.Y,pointerY-offset));
            int center=top-AutoScrollPosition.Y+dragging.Height/2;
            var next=original.Where(c=>c!=dragging).ToList();int index=next.Count(c=>centers[c]<center);
            next.Insert(index,dragging);
            if(!next.SequenceEqual(order)){order=next;Place(order,true);}
            dragging.Top=top;Invalidate(true);
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
