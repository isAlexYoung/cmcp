using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CMCP {
    // Own the complete icon surface: a transparent child has to repaint its parent
    // background separately and can expose a blank frame during hover redraws.
    internal sealed class CardIcon : Control {
        internal Bitmap Picture;
        Palette colors=Palette.Create(false);
        internal CardIcon(){
            Size=new Size(44,44);TabStop=false;Cursor=Cursors.Default;AccessibleRole=AccessibleRole.Graphic;
            SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Opaque|ControlStyles.ResizeRedraw,true);
        }
        internal void Apply(Palette palette,Color surface){colors=palette;BackColor=surface;Invalidate();}
        protected override void OnPaint(PaintEventArgs e){
            var g=e.Graphics;g.Clear(BackColor);g.SmoothingMode=SmoothingMode.AntiAlias;
            PaintUi.Box(g,new Rectangle(0,0,Width-1,Height-1),12,colors.Subtle,colors.Border);
            if(Picture!=null)g.DrawImage(Picture,new Rectangle(3,3,38,38));
            else PaintUi.Icon(g,"monitor",new Rectangle(10,10,24,24),colors.Blue);
        }
    }
    internal sealed class TargetCard : Panel {
        internal Target Target;
        internal CardPreference Preference;
        internal Palette Colors=Palette.Create(false);
        internal bool Selected, Expanded, BusyConnect, BusyStop;
        internal SshLogin Ssh;
        internal CloudCliLogin Cloud;
        internal Target CloudTarget,WebTunnelTarget,CloudTunnelTarget;
        internal bool TunnelActive {get{return !SshActive&&(CloudActive?Preference.cloudcliRoute:Preference.webRoute)=="ssh";}}
        internal string ConnectionName {get{return TunnelActive?"tunnel:"+(CloudActive?"cloudcli:":"web:")+Target.Name:CloudActive?"cloudcli:"+Target.Name:Target.Name;}}
        internal bool CloudActive {get{return Preference.loginMode=="cloudcli"||Preference.loginMode==""&&Target.Url.Length==0&&Cloud!=null&&Ssh==null;}}
        internal Target Connection {get{if(TunnelActive)return (CloudActive?CloudTunnelTarget:WebTunnelTarget)??new Target{Name=ConnectionName,Url="",Mode="SSH 隧道",State="stopped",Detail="已停止"};return !CloudActive?Target:CloudTarget??new Target{Name="cloudcli:"+Target.Name,Url=Cloud==null?"":Cloud.url,State="stopped",Mode="CloudCLI 登录",Detail="已停止",AutoLogin=Cloud!=null&&Cloud.autoLogin,HasSavedPassword=Cloud!=null&&Cloud.secret.Length>0};}}
        // The background SSH channel: empty while nothing runs, otherwise its reported phase.
        internal string SshState="";
        internal bool SshStopping;
        // What the backend or the setup action found this device's CloudCLI to be (CloudCliKinds).
        internal string CloudKind="";
        internal bool SelfHostedCloud {get{return CloudActive&&CloudKind==CloudCliKinds.SelfHosted;}}
        internal bool SetupOffered {get{return CloudActive&&!SshActive&&CloudKind!=CloudCliKinds.WebDesktop&&(Ssh!=null||CloudKind==CloudCliKinds.SelfHosted);}}
        internal bool SetupRunning;
        // Only the card's own button changes here; a running web connection is not touched.
        internal bool SshActive { get { return Preference.loginMode=="ssh"||(Preference.loginMode!="web"&&Preference.loginMode!="cloudcli"&&Ssh!=null&&(Ssh.active||Target.Url.Length==0)); } }
        internal string SshAddress {get{return Ssh==null?"":Ssh.Address;}}
        internal string Address {get{return SshActive||TunnelActive?(Ssh==null?"":Ssh.host):Connection.Url;}}
        internal readonly CardIcon IconNote=new CardIcon();
        internal string Caption { get { return Preference.label.Length>0?Preference.label:Preference.hideAddress?L.Text("未命名设备"):Target.Url.Length>0?new Uri(Target.Url).Host:Cloud!=null?new Uri(Cloud.url).Host:Ssh!=null?Ssh.host:Target.Name; } }
        internal readonly DropdownField AppChoice=new DropdownField(new[]{new System.Collections.Generic.KeyValuePair<string,string>("web","WebDesktop"),new System.Collections.Generic.KeyValuePair<string,string>("cloudcli","CloudCLI"),new System.Collections.Generic.KeyValuePair<string,string>("ssh","Terminal")}){AccessibleName="打开对象"};
        internal readonly DropdownField RouteChoice=new DropdownField(new[]{new System.Collections.Generic.KeyValuePair<string,string>("url","网址直连"),new System.Collections.Generic.KeyValuePair<string,string>("ssh","SSH 隧道")}){AccessibleName="连接方式"};
        internal event Action<TargetCard,string> AppChosen,RouteChosen;
        internal readonly ModernButton LoginSwitch=new ModernButton{Glyph="swap",Neutral=true,AccessibleName="切换登录方式"};
        internal readonly ModernButton Connect=new ModernButton();
        internal readonly ModernButton Edit=new ModernButton{Glyph="edit",AccessibleName="编辑设备"};
        internal readonly ModernButton Copy=new ModernButton{Glyph="copy",AccessibleName="复制设备地址"};
        internal readonly ModernButton Delete=new ModernButton{Glyph="delete",Destructive=true,AccessibleName="删除设备"};
        internal readonly ModernButton Toggle=new ModernButton{Glyph="chevron",AccessibleName="展开连接详情"};
        internal readonly ConnectionDetails Details=new ConnectionDetails();
        internal readonly Label StatusText=new Label{TextAlign=ContentAlignment.MiddleRight,AutoEllipsis=true};
        internal event Action<TargetCard> SwitchRequested, SelectedCard, EditRequested, CopyRequested, DeleteRequested, ConnectRequested, OpenRequested, StopRequested, LogsRequested, SetupRequested;
        internal event Action<TargetCard,int> MoveRequested;
        readonly LocalToolTip tips=new LocalToolTip();
        internal Func<TargetCard,bool,bool> AnimateExpansion;
        Bitmap icon;
        bool hovered, keyboardFocus, changingHover, dragArmed;
        Point dragStart;
        SnapshotOverlay hoverTransition;
        internal bool HoverAnimating{get{return hoverTransition!=null;}}
        internal bool Compact { get { return Width<1000; } }
        internal int HeaderHeight { get { return Compact?156:116; } }
        internal int FinalHeight { get { return HeaderHeight+(Expanded?Details.NeededHeight(Width-40)+22:0); } }
        internal bool ActionsVisible { get { return Connect.Visible&&Edit.Visible&&Copy.Visible&&Delete.Visible; } }

        internal TargetCard(Target target,CardPreference preference) {
            Target=target;Preference=preference;DoubleBuffered=true;
            SetStyle(ControlStyles.Selectable|ControlStyles.ResizeRedraw,true);TabStop=true;AllowDrop=true;Height=116;Cursor=Cursors.Hand;
            Controls.AddRange(new Control[]{AppChoice,RouteChoice,Connect,Edit,Copy,Delete,Toggle,StatusText,Details,IconNote});
            if(preference.icon.Length>0)icon=UiPreferences.DecodeIcon(preference.icon);IconNote.Picture=icon;
            IconNote.MouseUp+=delegate(object sender,MouseEventArgs e){if(e.Button==MouseButtons.Left){SelectCard();SetExpanded(!Expanded,true);}};
            AppChoice.Chosen+=value=>{if(AppChosen!=null)AppChosen(this,value);};RouteChoice.Chosen+=value=>{if(RouteChosen!=null)RouteChosen(this,value);};
            AppChoice.Menu.Closed+=delegate{QueuePointerCheck();};RouteChoice.Menu.Closed+=delegate{QueuePointerCheck();};
            LoginSwitch.Click+=delegate{if(SwitchRequested!=null)SwitchRequested(this);};
            Connect.Click+=delegate{if(ConnectRequested!=null)ConnectRequested(this);};
            Edit.Click+=delegate{if(EditRequested!=null)EditRequested(this);};
            Copy.Click+=delegate{if(CopyRequested!=null)CopyRequested(this);};
            Delete.Click+=delegate{if(DeleteRequested!=null)DeleteRequested(this);};
            // Select first, so the pictures of the transition already show the selection.
            Toggle.Click+=delegate{SelectCard();SetExpanded(!Expanded,true);};
            Details.Open.Click+=delegate{if(OpenRequested!=null)OpenRequested(this);};
            Details.Stop.Click+=delegate{if(StopRequested!=null)StopRequested(this);};
            Details.Logs.Click+=delegate{if(LogsRequested!=null)LogsRequested(this);};
            Details.Setup.Click+=delegate{if(SetupRequested!=null)SetupRequested(this);};
            tips.SetToolTip(Details.Setup,"通过 SSH 检查 VPS，只补上缺少的 Claude CLI 和 MCP 条目");
            tips.SetToolTip(LoginSwitch,"切换登录方式：网页桌面 / CloudCLI / SSH");
            tips.SetToolTip(Edit,"编辑名称、备注、图标和登录方式");
                        tips.SetToolTip(Delete,"删除这一台设备，其他连接保持不变");
            tips.SetToolTip(Toggle,"展开 / 收起详情");
            foreach(Control child in Controls)WirePointer(child);
            Details.Visible=false;
            AccessibleRole=AccessibleRole.Grouping;
            SetHover(false);RefreshTarget(target);Apply(Colors);
        }

        void WirePointer(Control control) {
            control.MouseEnter+=delegate{SetHover(true);};
            control.MouseLeave+=delegate{QueuePointerCheck();};
            control.MouseDown+=delegate{keyboardFocus=false;if(hoverTransition!=null)hoverTransition.Finish();};
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
            bool pointerInside=Visible&&(ClientRectangle.Contains(PointToClient(Cursor.Position))||AppChoice.IsOpen||RouteChoice.IsOpen);
            SetHover(pointerInside||(Visible&&ContainsFocus&&keyboardFocus));
        }

        internal void ClearPointer() { keyboardFocus=false;SetHover(false); }
        internal void BeginKeyboardNavigation() { keyboardFocus=true; }
        void SelectCard() { Focus();if(SelectedCard!=null)SelectedCard(this); }

        internal void RefreshTarget(Target target) {
            Target=target;Details.Target=Connection;Details.Ssh=SshActive?Ssh:null;Details.SshMode=SshActive;Details.Note="";tips.SetToolTip(IconNote,Preference.note??"",true);IconNote.AccessibleName=Caption;IconNote.AccessibleDescription=Preference.note??"";
            AccessibleName=Caption+"，"+(SshActive?"SSH":LocalState.Caption(Connection.State));
            AccessibleDescription=(SshActive?SshAddress:Connection.Url)+" · "+L.Text(Connection.Mode??"")+" · "+L.Message(Connection.Detail??"");
            UpdateActions();Invalidate();Details.Invalidate();
        }

        internal void UpdatePreference(CardPreference preference) {
            Bitmap replacement=preference.icon.Length>0?UiPreferences.DecodeIcon(preference.icon):null;
            var previous=icon;
            Preference=preference;icon=replacement;IconNote.Picture=icon;IconNote.Invalidate();
            if(previous!=null)previous.Dispose();
            RefreshTarget(Target);
        }

        internal void Apply(Palette colors) {
            Colors=colors;tips.Apply(colors);BackColor=colors.Page;
            Color fill=Selected?colors.Selected:colors.Surface;IconNote.Apply(colors,fill);
            Details.Apply(colors);Details.BackColor=fill;
            StatusText.BackColor=fill;
            StatusText.ForeColor=(SshActive?SshState=="ready":Connection.State=="connected")?colors.Success:colors.Muted;
            foreach(var field in new[]{AppChoice,RouteChoice}){field.Colors=colors;field.BackColor=fill;field.Invalidate();}
            foreach(var button in new[]{LoginSwitch,Connect,Edit,Copy,Delete,Toggle}){
                button.Colors=colors;button.BackColor=fill;button.Invalidate();
            }
            Invalidate();
        }

        internal void UpdateActions() {
            bool connected=Connection.State=="connected";
            bool connecting=BusyConnect||Connection.State=="connecting"||Connection.State=="configuring"||Connection.State=="waiting-login"||(Connection.State=="recovering"||Connection.State=="unstable");
            Details.StatusOverride=BusyStop?"正在停止":BusyConnect&&Connection.State=="stopped"?"连接中":"";
            Connect.Text=BusyStop?"正在停止":connected?"成功连接":connecting?"连接中":"未连接";
            Connect.Glyph=connected?"check":connecting?"stop":"play";
            Connect.Primary=connected&&!BusyStop;Connect.Neutral=!Connect.Primary;
            Connect.Enabled=!BusyStop;
            Edit.Enabled=Delete.Enabled=!BusyConnect&&!BusyStop;
            Details.Stop.Enabled=!BusyStop;Details.Open.Enabled=!BusyStop;
            string shown=SshActive?(SshStopping?"正在停止":SshState=="ready"?"已连接":SshState=="failed"?"连接异常":SshState=="recovering"?"正在恢复":SshState.Length>0?"连接中":"已停止"):BusyStop?"正在停止":(Connection.State=="recovering"||Connection.State=="unstable")?"正在恢复":connecting&&!connected?"连接中":LocalState.Caption(Connection.State);
            StatusText.Text=(SshActive?"Terminal":CloudActive?"CloudCLI":"WebDesktop")+" · "+L.Text(shown);StatusText.AccessibleName=StatusText.Text;
            tips.SetToolTip(Connect,connected?"点击停止此设备的连接":connecting?"连接中；可点击停止，或展开详情打开网页登录":"点击启动这一台设备");
            Connect.AccessibleName=L.Text(Connect.Text)+" · "+Connection.Url;
            Details.Stop.Text=BusyStop?"正在停止":"停止连接";
            LoginSwitch.Text=SshActive?"SSH":CloudActive?"CloudCLI":"网页桌面";LoginSwitch.Enabled=!BusyStop;
            Details.Open.Text=SshActive?"打开终端":CloudActive?"打开 CloudCLI":"打开云电脑";Details.Open.Glyph=SshActive?"terminal":CloudActive?"web":"monitor";
            Details.Stop.Visible=true;Details.Logs.Visible=Connection.Url.Length>0;
            bool setup=SetupOffered;if(Details.SetupShown!=setup){Details.SetupShown=setup;if(Expanded){Height=FinalHeight;PerformLayout();}}Details.Setup.Enabled=!SetupRunning&&!BusyStop;
            Details.Channel=SelfHostedCloud?(Ssh==null?"需要 SSH 信息":SshState=="ready"?"已连接":SshState=="failed"?"连接异常":SshState=="recovering"?"正在恢复":SshState.Length>0?"连接中":"已停止"):null;
            tips.SetToolTip(Copy,SshActive?"复制 IP":"复制设备地址");Copy.AccessibleName=L.Text(SshActive?"复制 IP":"复制设备地址");
            if(SshActive){
                Connect.Text="打开终端";Connect.Glyph="terminal";Connect.Primary=false;Connect.Neutral=true;Connect.Enabled=true;
                tips.SetToolTip(Connect,"用设置里选定的终端连接这台设备");Connect.AccessibleName=L.Text(Connect.Text)+" · "+SshAddress;
                Details.Stop.Enabled=SshState.Length>0&&!SshStopping;Details.Stop.Text=SshStopping?"正在停止":"停止连接";
            }
            AppChoice.ChoiceVisible=key=>key!="ssh"||SshActive||TunnelActive;
            AppChoice.Value=SshActive?"ssh":CloudActive?"cloudcli":"web";RouteChoice.DisplayOverride=SshActive?"SSH":null;RouteChoice.Value=SshActive||TunnelActive?"ssh":"url";RouteChoice.Enabled=!BusyStop;AppChoice.Enabled=!BusyStop;AppChoice.Invalidate();RouteChoice.Invalidate();
            Details.PerformLayout();LoginSwitch.Invalidate();Details.Open.Invalidate();
            Connect.Invalidate();StatusText.Invalidate();
        }

        internal void SetExpanded(bool value,bool animate) {
            if(animate&&value!=Expanded&&AnimateExpansion!=null&&AnimateExpansion(this,value))return;
            Expanded=value;Details.Visible=value;Toggle.Glyph=value?"up":"chevron";
            Toggle.AccessibleName=value?"收起连接详情":"展开连接详情";
            Height=FinalHeight;PerformLayout();Invalidate();
        }

        void SetHover(bool value) {
            if(changingHover)return;
            if(hovered==value&&StatusText.Visible==!value&&AppChoice.Visible==value&&RouteChoice.Visible==value&&Connect.Visible==value&&Edit.Visible==value&&Copy.Visible==value&&Delete.Visible==value)return;
            changingHover=true;
            Rectangle area=Compact?Rectangle.FromLTRB(20,96,Width-20,148):Rectangle.FromLTRB(110,20,Width-64,96);
            bool animate=Motion.Enabled&&IsHandleCreated&&Visible&&area.Width>0&&area.Height>0;
            Bitmap before=null;
            if(animate&&hoverTransition!=null&&hoverTransition.Bounds==area)before=hoverTransition.CurrentPicture();
            if(hoverTransition!=null)hoverTransition.Finish();
            if(animate&&before==null)before=HoverPicture(area);
            SuspendLayout();
            try {
                hovered=value;
                // Set both sides on every transition. Never hide status based
                // on a stale paint flag while the action controls are hidden.
                AppChoice.Visible=RouteChoice.Visible=value;foreach(var button in new[]{Connect,Edit,Copy,Delete})button.Visible=value;
                StatusText.Visible=!value;
            } finally {ResumeLayout();changingHover=false;}
            Invalidate();
            if(before!=null){
                var after=HoverPicture(area);
                var overlay=new SnapshotOverlay(before,area){ClickThrough=true};hoverTransition=overlay;
                overlay.Finished+=delegate{if(hoverTransition==overlay)hoverTransition=null;};
                Controls.Add(overlay);overlay.BringToFront();overlay.PlayHover(after);
            }
        }
        Bitmap HoverPicture(Rectangle area){using(var picture=SnapshotOverlay.Snapshot(this))return picture.Clone(area,System.Drawing.Imaging.PixelFormat.Format32bppRgb);}

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
            IconNote.Bounds=new Rectangle(51,35,44,44);
            int y=Compact?103:38, x=Width-(Compact?22:66)-268;
            int appWidth=Math.Max(144,AppChoice.PreferredFieldWidth),routeWidth=Math.Max(132,RouteChoice.PreferredFieldWidth);
            AppChoice.Bounds=new Rectangle(x-routeWidth-appWidth-16,y,appWidth,40);RouteChoice.Bounds=new Rectangle(x-routeWidth-8,y,routeWidth,40);
            Connect.Bounds=new Rectangle(x,y,136,40);
            Edit.Bounds=new Rectangle(x+144,y,36,40);
            Copy.Bounds=new Rectangle(x+188,y,36,40);
            Delete.Bounds=new Rectangle(x+232,y,36,40);
            Toggle.Bounds=new Rectangle(Width-54,Compact?32:38,36,40);
            StatusText.Bounds=new Rectangle(Width-284,Compact?103:38,210,40);
            Details.Bounds=new Rectangle(20,HeaderHeight,Math.Max(1,Width-40),Details.NeededHeight(Width-40));
            if(Height!=FinalHeight)Height=FinalHeight;
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
            PaintUi.Box(g,new Rectangle(1,1,Width-3,Height-3),Palette.Radius,Selected?Colors.Selected:Colors.Surface,Selected?Colors.SelectionBorder:Colors.Border);
            PaintUi.Icon(g,"grip",new Rectangle(16,44,22,28),Colors.Muted);
            int right=Compact?Width-72:hovered?AppChoice.Left-14:StatusText.Left-14;
            string label=Caption;
            using(var f=new Font(Font.FontFamily,Preference.hideAddress?Font.Size*1.18f:Font.Size,FontStyle.Bold))PaintUi.Text(g,label,f,new Rectangle(112,Preference.hideAddress?34:30,Math.Max(20,right-112),Preference.hideAddress?46:30),Colors.Text);
            if(!Preference.hideAddress)PaintUi.Text(g,Address,Font,new Rectangle(112,64,Math.Max(20,right-112),28),Colors.Blue);
            if(Expanded)using(var p=new Pen(Colors.Border))g.DrawLine(p,21,HeaderHeight-10,Width-21,HeaderHeight-10);
        }
        protected override void Dispose(bool disposing) {
            if(disposing){if(hoverTransition!=null){hoverTransition.Dispose();hoverTransition=null;}tips.Dispose();if(icon!=null)icon.Dispose();}
            base.Dispose(disposing);
        }
        protected override void OnVisibleChanged(EventArgs e){base.OnVisibleChanged(e);if(!Visible&&hoverTransition!=null)hoverTransition.Finish();}
    }
}
