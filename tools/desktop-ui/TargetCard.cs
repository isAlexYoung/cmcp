using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class TargetCard : Panel {
        internal Target Target;
        internal CardPreference Preference;
        internal Palette Colors=Palette.Create(false);
        internal bool Selected, Expanded, BusyConnect, BusyStop;
        internal readonly ModernButton Connect=new ModernButton();
        internal readonly ModernButton Edit=new ModernButton{Glyph="edit",AccessibleName="编辑云电脑"};
        internal readonly ModernButton Copy=new ModernButton{Glyph="copy",AccessibleName="复制云电脑地址"};
        internal readonly ModernButton Delete=new ModernButton{Glyph="delete",Destructive=true,AccessibleName="删除云电脑"};
        internal readonly ModernButton Toggle=new ModernButton{Glyph="chevron",AccessibleName="展开连接详情"};
        internal readonly ConnectionDetails Details=new ConnectionDetails();
        internal readonly Label StatusText=new Label{TextAlign=ContentAlignment.MiddleRight,AutoEllipsis=true};
        internal event Action<TargetCard> SelectedCard, EditRequested, CopyRequested, DeleteRequested, ConnectRequested, OpenRequested, StopRequested, LogsRequested;
        internal event Action<TargetCard,int> MoveRequested;
        readonly LocalToolTip tips=new LocalToolTip();
        readonly Timer animation=new Timer{Interval=15};
        Bitmap icon;
        bool hovered, keyboardFocus, changingHover, dragArmed;
        Point dragStart;
        internal bool Compact { get { return Width<860; } }
        internal int HeaderHeight { get { return Compact?156:116; } }
        internal int FinalHeight { get { return HeaderHeight+(Expanded?Details.NeededHeight(Width-40)+22:0); } }
        internal bool ActionsVisible { get { return Connect.Visible&&Edit.Visible&&Copy.Visible&&Delete.Visible; } }

        internal TargetCard(Target target,CardPreference preference) {
            Target=target;Preference=preference;DoubleBuffered=true;
            SetStyle(ControlStyles.Selectable|ControlStyles.ResizeRedraw,true);TabStop=true;AllowDrop=true;Height=116;Cursor=Cursors.Hand;
            Controls.AddRange(new Control[]{Connect,Edit,Copy,Delete,Toggle,StatusText,Details});
            if(preference.icon.Length>0)icon=UiPreferences.DecodeIcon(preference.icon);
            Connect.Click+=delegate{if(ConnectRequested!=null)ConnectRequested(this);};
            Edit.Click+=delegate{if(EditRequested!=null)EditRequested(this);};
            Copy.Click+=delegate{if(CopyRequested!=null)CopyRequested(this);};
            Delete.Click+=delegate{if(DeleteRequested!=null)DeleteRequested(this);};
            Toggle.Click+=delegate{SetExpanded(!Expanded,true);SelectCard();};
            Details.Open.Click+=delegate{if(OpenRequested!=null)OpenRequested(this);};
            Details.Stop.Click+=delegate{if(StopRequested!=null)StopRequested(this);};
            Details.Logs.Click+=delegate{if(LogsRequested!=null)LogsRequested(this);};
            tips.SetToolTip(Edit,"编辑备注、图标和云电脑地址");
            tips.SetToolTip(Copy,"复制云电脑地址");
            tips.SetToolTip(Delete,"删除这一台云电脑，其他连接保持不变");
            tips.SetToolTip(Toggle,"展开 / 收起详情");
            tips.SetToolTip(this,"点击卡片展开详情；拖动左侧手柄排序；Alt + ↑ / ↓ 调整顺序");
            foreach(Control child in Controls)WirePointer(child);
            animation.Tick+=delegate{
                int diff=FinalHeight-Height;
                if(Math.Abs(diff)<3){Height=FinalHeight;animation.Stop();}
                else Height+=Math.Sign(diff)*Math.Max(3,Math.Abs(diff)/2);
            };
            Details.Visible=false;
            AccessibleRole=AccessibleRole.Grouping;
            SetHover(false);RefreshTarget(target);Apply(Colors);
        }

        void WirePointer(Control control) {
            control.MouseEnter+=delegate{SetHover(true);};
            control.MouseLeave+=delegate{QueuePointerCheck();};
            control.MouseDown+=delegate{keyboardFocus=false;};
            control.Enter+=delegate{
                if(changingHover)return;
                if(SelectedCard!=null)SelectedCard(this);
                SyncPointer();
            };
            control.Leave+=delegate{QueuePointerCheck();};
            foreach(Control child in control.Controls)WirePointer(child);
        }

        void QueuePointerCheck() {
            if(!IsHandleCreated||IsDisposed||Disposing)return;
            BeginInvoke(new Action(delegate{if(!IsDisposed&&!Disposing)SyncPointer();}));
        }

        internal void SyncPointer() {
            if(IsDisposed||changingHover)return;
            bool pointerInside=Visible&&ClientRectangle.Contains(PointToClient(Cursor.Position));
            SetHover(pointerInside||(Visible&&ContainsFocus&&keyboardFocus));
        }

        internal void ClearPointer() { keyboardFocus=false;SetHover(false); }
        internal void BeginKeyboardNavigation() { keyboardFocus=true; }
        void SelectCard() { Focus();if(SelectedCard!=null)SelectedCard(this); }

        internal void RefreshTarget(Target target) {
            Target=target;Details.Target=target;
            AccessibleName=(Preference.label.Length>0?Preference.label:new Uri(target.Url).Host)+"，"+LocalState.Caption(target.State);
            AccessibleDescription=target.Url+" · "+L.Text(target.Mode)+" · "+L.Message(target.Detail);
            UpdateActions();Invalidate();Details.Invalidate();
        }

        internal void UpdatePreference(CardPreference preference) {
            Bitmap replacement=preference.icon.Length>0?UiPreferences.DecodeIcon(preference.icon):null;
            var previous=icon;
            Preference=preference;icon=replacement;
            if(previous!=null)previous.Dispose();
            RefreshTarget(Target);
        }

        internal void Apply(Palette colors) {
            Colors=colors;tips.Apply(colors);BackColor=colors.Page;
            Color fill=Selected?colors.Selected:colors.Surface;
            Details.Apply(colors);Details.BackColor=fill;
            StatusText.BackColor=fill;
            StatusText.ForeColor=Target.State=="connected"?colors.Success:colors.Muted;
            foreach(var button in new[]{Connect,Edit,Copy,Delete,Toggle}){
                button.Colors=colors;button.BackColor=fill;button.Invalidate();
            }
            Invalidate();
        }

        internal void UpdateActions() {
            bool connected=Target.State=="connected";
            bool connecting=BusyConnect||Target.State=="connecting"||Target.State=="configuring"||Target.State=="waiting-login"||Target.State=="recovering";
            Details.StatusOverride=BusyStop?"正在停止":BusyConnect&&Target.State=="stopped"?"连接中":"";
            Connect.Text=BusyStop?"正在停止":connected?"成功连接":connecting?"连接中":"未连接";
            Connect.Glyph=connected?"check":connecting?"stop":"play";
            Connect.Primary=connected&&!BusyStop;Connect.Neutral=!Connect.Primary;
            Connect.Enabled=!BusyStop;
            Edit.Enabled=Delete.Enabled=!BusyConnect&&!BusyStop;
            Details.Stop.Enabled=!BusyStop;Details.Open.Enabled=!BusyStop;
            StatusText.Text=BusyStop?"正在停止":Target.State=="recovering"?"正在恢复":connecting&&!connected?"连接中":LocalState.Caption(Target.State);
            StatusText.Text=L.Text(StatusText.Text);StatusText.AccessibleName=StatusText.Text;
            tips.SetToolTip(Connect,connected?"点击停止此云电脑的连接":connecting?"连接中；可点击停止，或展开详情打开网页登录":"点击启动这一台云电脑");
            Connect.AccessibleName=L.Text(Connect.Text)+" · "+Target.Url;
            Details.Stop.Text=BusyStop?"正在停止":"停止连接";
            Connect.Invalidate();StatusText.Invalidate();
        }

        internal void SetExpanded(bool value,bool animate) {
            Expanded=value;Details.Visible=value;Toggle.Glyph=value?"up":"chevron";
            Toggle.AccessibleName=value?"收起连接详情":"展开连接详情";
            if(animate)animation.Start();else{animation.Stop();Height=FinalHeight;}
            PerformLayout();Invalidate();
        }

        void SetHover(bool value) {
            if(changingHover)return;
            changingHover=true;SuspendLayout();
            try {
                hovered=value;
                // Set both sides on every transition. Never hide status based
                // on a stale paint flag while the action controls are hidden.
                foreach(var button in new[]{Connect,Edit,Copy,Delete})button.Visible=value;
                StatusText.Visible=!value;
            } finally {ResumeLayout();changingHover=false;}
            Invalidate();
        }

        internal void TestHover(bool value) { SetHover(value); }
        protected override void OnGotFocus(EventArgs e) {
            base.OnGotFocus(e);
            if(changingHover)return;
            if(SelectedCard!=null)SelectedCard(this);
            SyncPointer();
        }
        protected override void OnLostFocus(EventArgs e) {base.OnLostFocus(e);QueuePointerCheck();}
        protected override void OnMouseEnter(EventArgs e) {base.OnMouseEnter(e);SetHover(true);}
        protected override void OnMouseLeave(EventArgs e) {base.OnMouseLeave(e);QueuePointerCheck();}
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e);SelectCard();keyboardFocus=false;
            dragStart=e.Location;dragArmed=e.Button==MouseButtons.Left&&e.X<42&&e.Y<HeaderHeight;
        }
        protected override void OnMouseMove(MouseEventArgs e) {
            base.OnMouseMove(e);SetHover(true);
            var list=Parent as CardList;
            if(list==null)return;
            if(dragArmed&&e.Button==MouseButtons.Left&&(Math.Abs(e.X-dragStart.X)>8||Math.Abs(e.Y-dragStart.Y)>8)){
                dragArmed=false;Capture=true;list.BeginSort(this,list.PointToClient(PointToScreen(dragStart)).Y);
            }
            if(list.Sorting&&Capture)list.MoveSort(list.PointToClient(PointToScreen(e.Location)).Y);
        }
        protected override void OnMouseUp(MouseEventArgs e) {
            base.OnMouseUp(e);
            if(e.Button!=MouseButtons.Left)return;
            var list=Parent as CardList;
            if(list!=null&&list.Sorting){list.EndSort(true);Capture=false;dragArmed=false;return;}
            bool grip=dragArmed;dragArmed=false;
            if(!grip&&e.Y<HeaderHeight&&e.X<Width-64){
                SetExpanded(!Expanded,true);
            }
        }
        protected override void OnMouseCaptureChanged(EventArgs e){base.OnMouseCaptureChanged(e);var list=Parent as CardList;if(!Capture&&list!=null&&list.Sorting)list.EndSort(false);}
        internal void TestCardClick(int x,int y){OnMouseUp(new MouseEventArgs(MouseButtons.Left,1,x,y,0));}
        protected override bool ProcessCmdKey(ref Message m,Keys keys) {
            var list=Parent as CardList;
            if(keys==Keys.Escape&&list!=null&&list.Sorting){list.EndSort(false);Capture=false;dragArmed=false;return true;}
            if(keys==(Keys.Alt|Keys.Up)||keys==(Keys.Alt|Keys.Down)){
                if(MoveRequested!=null)MoveRequested(this,keys==(Keys.Alt|Keys.Up)?-1:1);return true;
            }
            if(keys==Keys.Enter||keys==Keys.Space){SetExpanded(!Expanded,true);return true;}
            return base.ProcessCmdKey(ref m,keys);
        }
        protected override void OnLayout(LayoutEventArgs e) {
            base.OnLayout(e);if(Details==null)return;
            int y=Compact?103:38, x=Width-(Compact?22:66)-268;
            Connect.Bounds=new Rectangle(x,y,136,40);
            Edit.Bounds=new Rectangle(x+144,y,36,40);
            Copy.Bounds=new Rectangle(x+188,y,36,40);
            Delete.Bounds=new Rectangle(x+232,y,36,40);
            Toggle.Bounds=new Rectangle(Width-54,Compact?32:38,36,40);
            StatusText.Bounds=new Rectangle(Width-250,Compact?103:38,176,40);
            Details.Bounds=new Rectangle(20,HeaderHeight,Math.Max(1,Width-40),Details.NeededHeight(Width-40));
            if(!animation.Enabled&&Height!=FinalHeight)Height=FinalHeight;
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
            PaintUi.Box(g,new Rectangle(1,1,Width-3,Height-3),Palette.Radius,Selected?Colors.Selected:Colors.Surface,Selected?Colors.SelectionBorder:Colors.Border);
            PaintUi.Icon(g,"grip",new Rectangle(16,44,22,28),Colors.Muted);
            PaintUi.Box(g,new Rectangle(51,35,44,44),12,Colors.Subtle,Colors.Border);
            if(icon!=null)g.DrawImage(icon,new Rectangle(54,38,38,38));
            else PaintUi.Icon(g,"monitor",new Rectangle(61,45,24,24),Colors.Blue);
            int right=Compact?Width-72:hovered?Connect.Left-14:StatusText.Left-14;
            string label=Preference.label.Length>0?Preference.label:new Uri(Target.Url).Host;
            using(var f=new Font(Font,FontStyle.Bold))PaintUi.Text(g,label,f,new Rectangle(112,30,Math.Max(20,right-112),30),Colors.Text);
            PaintUi.Text(g,Target.Url,Font,new Rectangle(112,64,Math.Max(20,right-112),28),Colors.Blue);
            if(Expanded)using(var p=new Pen(Colors.Border))g.DrawLine(p,21,HeaderHeight-10,Width-21,HeaderHeight-10);
        }
        protected override void Dispose(bool disposing) {
            if(disposing){animation.Stop();animation.Dispose();tips.Dispose();if(icon!=null)icon.Dispose();}
            base.Dispose(disposing);
        }
    }
}
