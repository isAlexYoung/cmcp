using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeMcp {
    internal sealed class Palette {
        internal bool Dark;
        internal Color Page, Surface, Subtle, Border, Text, Muted, Blue, Selected, SelectionBorder, Danger, Success;
        internal const int Gap = 14, Radius = 15, Header = 96;
        internal static Palette Create(bool dark) {
            return dark ? new Palette { Dark=true, Page=Color.FromArgb(20,22,26), Surface=Color.FromArgb(28,30,35), Subtle=Color.FromArgb(38,41,47), Border=Color.FromArgb(56,59,66), Text=Color.FromArgb(234,236,240), Muted=Color.FromArgb(154,162,175), Blue=Color.FromArgb(86,157,255), Selected=Color.FromArgb(29,43,61), SelectionBorder=Color.FromArgb(76,132,206), Danger=Color.FromArgb(238,115,120), Success=Color.FromArgb(100,196,153) }
            : new Palette { Page=Color.White, Surface=Color.White, Subtle=Color.FromArgb(246,247,249), Border=Color.FromArgb(226,229,235), Text=Color.FromArgb(28,35,46), Muted=Color.FromArgb(121,131,147), Blue=Color.FromArgb(33,126,246), Selected=Color.FromArgb(242,248,255), SelectionBorder=Color.FromArgb(125,180,255), Danger=Color.FromArgb(200,76,86), Success=Color.FromArgb(38,143,103) };
        }
    }
    internal static class PaintUi {
        internal static GraphicsPath Round(Rectangle rect, int radius) {
            int d = Math.Max(2,Math.Min(radius*2,Math.Min(rect.Width,rect.Height)));
            var path = new GraphicsPath(); path.AddArc(rect.X,rect.Y,d,d,180,90); path.AddArc(rect.Right-d,rect.Y,d,d,270,90);
            path.AddArc(rect.Right-d,rect.Bottom-d,d,d,0,90); path.AddArc(rect.X,rect.Bottom-d,d,d,90,90); path.CloseFigure(); return path;
        }
        internal static void Box(Graphics g, Rectangle r, int radius, Color back, Color border) {
            using(var path=Round(r,radius)) { using(var brush=new SolidBrush(back)) g.FillPath(brush,path); using(var pen=new Pen(border)) g.DrawPath(pen,path); }
        }
        internal static void Text(Graphics g,string text,Font font,Rectangle r,Color color, bool right=false) {
            if (r.Width <= 0 || r.Height <= 0) return;
            TextRenderer.DrawText(g,text,font,r,color,TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis | TextFormatFlags.VerticalCenter | (right?TextFormatFlags.Right:TextFormatFlags.Left));
        }
        internal static void Icon(Graphics g,string kind,Rectangle r,Color color) {
            var old=g.Save(); g.TranslateTransform(r.X,r.Y); g.ScaleTransform(r.Width/24f,r.Height/24f);
            using(var p=new Pen(color,1.65f)) { p.StartCap=p.EndCap=LineCap.Round; p.LineJoin=LineJoin.Round;
                switch(kind) {
                    case "plus": g.DrawLine(p,12,5,12,19);g.DrawLine(p,5,12,19,12);break;
                    case "edit": g.DrawLines(p,new Point[]{new Point(5,16),new Point(16,5),new Point(20,9),new Point(9,20),new Point(4,21),new Point(5,16)});g.DrawLine(p,14,7,18,11);break;
                    case "copy": g.DrawRectangle(p,8,8,12,13);g.DrawLines(p,new Point[]{new Point(15,4),new Point(4,4),new Point(4,16)});break;
                    case "delete":g.DrawLine(p,4,7,20,7);g.DrawLine(p,9,3,15,3);g.DrawLines(p,new Point[]{new Point(6,7),new Point(7,21),new Point(17,21),new Point(18,7)});g.DrawLine(p,10,10,10,17);g.DrawLine(p,14,10,14,17);break;
                    case "chevron":g.DrawLines(p,new Point[]{new Point(6,9),new Point(12,15),new Point(18,9)});break;
                    case "up":g.DrawLines(p,new Point[]{new Point(6,15),new Point(12,9),new Point(18,15)});break;
                    case "play":g.DrawPolygon(p,new Point[]{new Point(7,4),new Point(20,12),new Point(7,20)});break;
                    case "check":g.DrawLines(p,new Point[]{new Point(4,12),new Point(9,17),new Point(20,6)});break;
                    case "stop":g.DrawRectangle(p,6,6,12,12);break;
                    case "monitor":g.DrawRectangle(p,3,4,18,13);g.DrawLine(p,12,17,12,21);g.DrawLine(p,7,21,17,21);break;
                    case "theme":g.DrawEllipse(p,5,5,14,14);using(var b=new SolidBrush(color))g.FillPie(b,5,5,14,14,90,180);break;
                    case "refresh":g.DrawArc(p,4,4,16,16,40,285);g.DrawLines(p,new Point[]{new Point(20,4),new Point(20,10),new Point(14,10)});break;
                    case "settings":g.DrawEllipse(p,5,5,14,14);g.DrawEllipse(p,9,9,6,6);for(int i=0;i<8;i++){double a=i*Math.PI/4;g.DrawLine(p,12+(float)Math.Cos(a)*8,12+(float)Math.Sin(a)*8,12+(float)Math.Cos(a)*11,12+(float)Math.Sin(a)*11);}break;
                    case "grip":using(var b=new SolidBrush(color))for(int y=5;y<=19;y+=7)for(int x=8;x<=15;x+=7)g.FillEllipse(b,x-1,y-1,2,2);break;
                    default:g.DrawEllipse(p,4,4,16,16);g.DrawLine(p,12,8,12,13);g.DrawEllipse(p,11,16,1,1);break;
                }
            } g.Restore(old);
        }
    }
    internal sealed class ModernButton : Button {
        internal Palette Colors=Palette.Create(false);
        internal string Glyph="";
        internal bool Primary, Neutral, Destructive;
        bool hover, pressed;
        internal ModernButton() {
            FlatStyle=FlatStyle.Flat; FlatAppearance.BorderSize=0; Size=new Size(32,32); Cursor=Cursors.Hand;
            SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);
        }
        protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){hover=false;pressed=false;Invalidate();base.OnMouseLeave(e);}
        protected override void OnMouseDown(MouseEventArgs e){pressed=true;Invalidate();base.OnMouseDown(e);}
        protected override void OnMouseUp(MouseEventArgs e){pressed=false;Invalidate();base.OnMouseUp(e);}
        protected override void OnPaint(PaintEventArgs e) {
            var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
            Color bg=Primary?Colors.Blue:Neutral?Colors.Subtle:BackColor;
            if(Enabled && hover)bg=Primary?ControlPaint.Dark(Colors.Blue,0.08f):Colors.Subtle;
            if(pressed && Enabled)bg=ControlPaint.Dark(bg,0.06f);
            Color fg=!Enabled?Colors.Muted:Primary?Color.White:Destructive?Colors.Danger:Colors.Text;
            using(var b=new SolidBrush(BackColor))g.FillRectangle(b,ClientRectangle);
            PaintUi.Box(g,new Rectangle(1,1,Math.Max(1,Width-3),Math.Max(1,Height-3)),8,bg,bg);
            int x=Text.Length==0?(Width-18)/2:12;
            if(Glyph.Length>0)PaintUi.Icon(g,Glyph,new Rectangle(x,(Height-18)/2,18,18),fg);
            if(Text.Length>0)PaintUi.Text(g,Text,Font,new Rectangle(Glyph.Length>0?36:10,0,Width-(Glyph.Length>0?42:20),Height),fg);
            if(Focused)ControlPaint.DrawFocusRectangle(g,new Rectangle(4,4,Width-8,Height-8),fg,bg);
        }
    }
    internal sealed class DashboardToolbar : Panel {
        internal readonly ModernButton Settings=new ModernButton { Glyph="settings",Enabled=false,AccessibleName="设置（尚未开放）" }, UpdateButton=new ModernButton { Glyph="refresh",Enabled=false,AccessibleName="更新（尚未开放）" }, Theme=new ModernButton { Glyph="theme",AccessibleName="切换浅色或深色" }, Add=new ModernButton { Glyph="plus",Text="添加云电脑",Primary=true,AccessibleName="添加云电脑" };
        readonly ToolTip tips=new ToolTip();
        internal Palette Colors=Palette.Create(false);
        internal DashboardToolbar() {
            Height=72;Dock=DockStyle.Top;DoubleBuffered=true;
            Controls.AddRange(new Control[]{Settings,UpdateButton,Theme,Add});
            tips.SetToolTip(this,"设置和更新入口将在后续版本开放");
            tips.SetToolTip(Settings,"设置将在后续版本开放");tips.SetToolTip(UpdateButton,"更新将在后续版本开放（不会自动更新）");tips.SetToolTip(Theme,"切换浅色 / 深色主题");tips.SetToolTip(Add,"添加新的云电脑，不会自动连接");
        }
        internal void Apply(Palette colors){Colors=colors;BackColor=colors.Surface;foreach(ModernButton b in Controls){b.Colors=colors;b.BackColor=b==Settings||b==UpdateButton?colors.Subtle:colors.Surface;b.Invalidate();}Invalidate();}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);Settings.Bounds=new Rectangle(207,20,32,32);UpdateButton.Bounds=new Rectangle(245,20,32,32);Theme.Bounds=new Rectangle(Width-211,20,34,32);Add.Bounds=new Rectangle(Width-164,18,136,36);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;PaintUi.Box(e.Graphics,new Rectangle(201,16,82,40),10,Colors.Subtle,Colors.Subtle);using(var f=new Font(Font.FontFamily,14,FontStyle.Bold))PaintUi.Text(e.Graphics,"Claude MCP",f,new Rectangle(28,17,165,36),Colors.Blue);using(var p=new Pen(Colors.Border))e.Graphics.DrawLine(p,0,Height-1,Width,Height-1);}
        protected override void Dispose(bool disposing){if(disposing)tips.Dispose();base.Dispose(disposing);}
    }
    internal sealed class ConnectionDetails : Panel {
        internal Target Target;
        internal Palette Colors=Palette.Create(false);
        internal readonly ModernButton Open=new ModernButton{Glyph="monitor",Text="打开云电脑"}, Stop=new ModernButton{Glyph="stop",Text="停止连接",Destructive=true}, Logs=new ModernButton{Text="查看日志"};
        internal ConnectionDetails(){DoubleBuffered=true;Controls.AddRange(new Control[]{Open,Stop,Logs});}
        internal void Apply(Palette colors){Colors=colors;BackColor=colors.Surface;foreach(ModernButton b in Controls){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}Invalidate();}
        internal int NeededHeight(int width){return 148+TextRenderer.MeasureText(Target==null?"":Target.Detail,Font,new Size(Math.Max(100,width-44),1000),TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix).Height;}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);Open.Bounds=new Rectangle(14,Height-43,145,32);Stop.Bounds=new Rectangle(166,Height-43,128,32);Logs.Bounds=new Rectangle(301,Height-43,92,32);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Target==null)return;var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;PaintUi.Box(g,new Rectangle(0,0,Width-1,Height-1),11,Colors.Surface,Colors.Border);
            PaintUi.Text(g,"连接状态",Font,new Rectangle(18,10,100,24),Colors.Muted);PaintUi.Text(g,LocalState.Caption(Target.State),Font,new Rectangle(130,10,Width-148,24),Target.State=="connected"?Colors.Success:Colors.Text,true);
            PaintUi.Text(g,"登录方式",Font,new Rectangle(18,40,100,24),Colors.Muted);PaintUi.Text(g,Target.Mode,Font,new Rectangle(130,40,Width-148,24),Colors.Text,true);
            using(var p=new Pen(Colors.Border))g.DrawLine(p,18,76,Width-18,76);
            TextRenderer.DrawText(g,Target.Detail,Font,new Rectangle(18,88,Width-36,Height-137),Colors.Muted,TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix);
        }
    }
    internal sealed class TargetCard : Panel {
        internal Target Target; internal CardPreference Preference;
        internal Palette Colors=Palette.Create(false);
        internal bool Selected, Expanded, BusyConnect, BusyStop;
        internal readonly ModernButton Connect=new ModernButton(), Edit=new ModernButton{Glyph="edit",AccessibleName="编辑云电脑"}, Copy=new ModernButton{Glyph="copy",AccessibleName="复制云电脑地址"}, Delete=new ModernButton{Glyph="delete",Destructive=true,AccessibleName="删除云电脑"}, Toggle=new ModernButton{Glyph="chevron",AccessibleName="展开连接详情"};
        internal readonly ConnectionDetails Details=new ConnectionDetails();
        internal event Action<TargetCard> SelectedCard, EditRequested, CopyRequested, DeleteRequested, ConnectRequested, OpenRequested, StopRequested, LogsRequested;
        internal event Action<TargetCard,int> MoveRequested;
        readonly ToolTip tips=new ToolTip(); readonly Timer hoverTimer=new Timer{Interval=90}, animation=new Timer{Interval=15};
        Bitmap icon;bool hovered, keyboardFocus;Point dragStart;bool dragArmed;
        internal bool Compact { get { return Width<760; } }
        int HeaderHeight { get { return Compact?128:96; } }
        internal int FinalHeight {get{return HeaderHeight+(Expanded?Details.NeededHeight(Width-32)+18:0);}}
        internal TargetCard(Target target,CardPreference preference) {
            Target=target;Preference=preference;DoubleBuffered=true;SetStyle(ControlStyles.Selectable,true);TabStop=true;AllowDrop=true;Height=96;Cursor=Cursors.Hand;
            Controls.AddRange(new Control[]{Connect,Edit,Copy,Delete,Toggle,Details});
            if(preference.icon.Length>0)icon=UiPreferences.DecodeIcon(preference.icon);
            Connect.Click+=delegate{if(ConnectRequested!=null)ConnectRequested(this);};Edit.Click+=delegate{if(EditRequested!=null)EditRequested(this);};Copy.Click+=delegate{if(CopyRequested!=null)CopyRequested(this);};Delete.Click+=delegate{if(DeleteRequested!=null)DeleteRequested(this);};
            Toggle.Click+=delegate{SetExpanded(!Expanded,true);SelectCard();};Details.Open.Click+=delegate{if(OpenRequested!=null)OpenRequested(this);};Details.Stop.Click+=delegate{if(StopRequested!=null)StopRequested(this);};Details.Logs.Click+=delegate{if(LogsRequested!=null)LogsRequested(this);};
            tips.SetToolTip(Edit,"编辑备注、图标和云电脑地址");tips.SetToolTip(Copy,"复制云电脑地址");tips.SetToolTip(Delete,"删除这一台云电脑，其他连接保持不变");tips.SetToolTip(Toggle,"展开 / 收起详情");tips.SetToolTip(this,"点击卡片展开详情；拖动左侧手柄排序；Alt + ↑ / ↓ 调整顺序");
            foreach(Control child in Controls){child.Enter+=delegate{keyboardFocus=Control.MouseButtons==MouseButtons.None;if(SelectedCard!=null)SelectedCard(this);UpdateHover();};child.Leave+=delegate{if(IsHandleCreated&&!Disposing)BeginInvoke(new Action(UpdateHover));};child.MouseDown+=delegate{keyboardFocus=false;};child.MouseEnter+=delegate{SetHover(true);};}
            hoverTimer.Tick+=delegate{UpdateHover();};hoverTimer.Start();
            animation.Tick+=delegate{int diff=FinalHeight-Height;if(Math.Abs(diff)<3){Height=FinalHeight;animation.Stop();}else Height+=Math.Sign(diff)*Math.Max(3,Math.Abs(diff)/2);};
            foreach(var button in new[]{Connect,Edit,Copy,Delete})button.Visible=false;
            Details.Visible=false;AccessibleRole=AccessibleRole.Grouping;RefreshTarget(target);Apply(Colors);
        }
        void SelectCard(){Focus();if(SelectedCard!=null)SelectedCard(this);}
        internal void RefreshTarget(Target t){Target=t;Details.Target=t;AccessibleName=(Preference.label.Length>0?Preference.label:new Uri(t.Url).Host)+"，"+LocalState.Caption(t.State);AccessibleDescription=t.Url+"，"+t.Mode+"。"+t.Detail;UpdateActions();Invalidate();Details.Invalidate();}
        internal void Apply(Palette p){Colors=p;BackColor=p.Page;Color fill=Selected?p.Selected:p.Surface;Details.Apply(p);Details.BackColor=fill;foreach(var b in new[]{Connect,Edit,Copy,Delete,Toggle}){b.Colors=p;b.BackColor=fill;b.Invalidate();}Invalidate();}
        internal void UpdateActions(){
            bool connected=Target.State=="connected", connecting=BusyConnect || Target.State=="connecting" || Target.State=="configuring" || Target.State=="waiting-login";
            Connect.Text=connected?"成功连接":connecting?"连接中":"未连接";Connect.Glyph=connected?"check":connecting?"refresh":"play";Connect.Primary=connected;Connect.Neutral=!connected;
            Connect.Enabled=!BusyStop;Edit.Enabled=Delete.Enabled=!BusyConnect&&!BusyStop;Details.Stop.Enabled=!BusyStop;Details.Open.Enabled=!BusyStop;
            tips.SetToolTip(Connect,connected?"点击停止此云电脑的连接":connecting?"连接中；可点击停止，或展开详情打开网页登录":"点击启动这一台云电脑");Connect.AccessibleName=Connect.Text+"："+Target.Url;
            Details.Stop.Text=BusyStop?"正在停止":"停止连接";Connect.Invalidate();
        }
        internal void SetExpanded(bool value,bool animate){Expanded=value;Details.Visible=value;Toggle.Glyph=value?"up":"chevron";Toggle.AccessibleName=value?"收起连接详情":"展开连接详情";if(animate)animation.Start();else Height=FinalHeight;PerformLayout();Invalidate();}
        void SetHover(bool value){if(hovered==value)return;hovered=value;foreach(var b in new[]{Connect,Edit,Copy,Delete})b.Visible=value;Invalidate();}
        void UpdateHover(){if(IsDisposed)return;SetHover(ClientRectangle.Contains(PointToClient(Cursor.Position))||(ContainsFocus&&keyboardFocus));}
        internal void TestHover(bool value){SetHover(value);}
        protected override void OnGotFocus(EventArgs e){keyboardFocus=Control.MouseButtons==MouseButtons.None;if(SelectedCard!=null)SelectedCard(this);UpdateHover();base.OnGotFocus(e);}
        protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);UpdateHover();}
        protected override void OnMouseEnter(EventArgs e){SetHover(true);base.OnMouseEnter(e);}
        protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);SelectCard();keyboardFocus=false;dragStart=e.Location;dragArmed=e.Button==MouseButtons.Left&&e.X<38&&e.Y<HeaderHeight;}
        protected override void OnMouseMove(MouseEventArgs e){base.OnMouseMove(e);if(dragArmed&&e.Button==MouseButtons.Left&&(Math.Abs(e.X-dragStart.X)>5||Math.Abs(e.Y-dragStart.Y)>5)){dragArmed=false;DoDragDrop(Target.Name,DragDropEffects.Move);}}
        protected override void OnMouseUp(MouseEventArgs e){base.OnMouseUp(e);if(e.Button!=MouseButtons.Left)return;bool grip=dragArmed;dragArmed=false;if(!grip&&e.Y<HeaderHeight&&e.X<Width-54){if(e.Y>=50&&e.Y<=78&&e.X>82){if(OpenRequested!=null)OpenRequested(this);}else SetExpanded(!Expanded,true);}}
        protected override bool ProcessCmdKey(ref Message m,Keys keys){if(keys==(Keys.Alt|Keys.Up)||keys==(Keys.Alt|Keys.Down)){if(MoveRequested!=null)MoveRequested(this,keys==(Keys.Alt|Keys.Up)?-1:1);return true;}if(keys==Keys.Enter||keys==Keys.Space){SetExpanded(!Expanded,true);return true;}return base.ProcessCmdKey(ref m,keys);}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);if(Details==null)return;int y=Compact?85:29;int x=Width-(Compact?18:52)-218;Connect.Bounds=new Rectangle(x,y,116,32);Edit.Bounds=new Rectangle(x+124,y,28,32);Copy.Bounds=new Rectangle(x+157,y,28,32);Delete.Bounds=new Rectangle(x+190,y,28,32);Toggle.Bounds=new Rectangle(Width-46,Compact?25:30,28,30);
            Details.Bounds=new Rectangle(16,HeaderHeight,Math.Max(1,Width-32),Details.NeededHeight(Width-32));if(!animation.Enabled&&Height!=FinalHeight)Height=FinalHeight;
        }
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;PaintUi.Box(g,new Rectangle(1,1,Width-3,Height-3),Palette.Radius,Selected?Colors.Selected:Colors.Surface,Selected?Colors.SelectionBorder:Colors.Border);
            PaintUi.Icon(g,"grip",new Rectangle(16,35,18,24),Colors.Muted);PaintUi.Box(g,new Rectangle(47,28,36,36),10,Colors.Subtle,Colors.Border);
            if(icon!=null)g.DrawImage(icon,new Rectangle(49,30,32,32));else PaintUi.Icon(g,"monitor",new Rectangle(55,36,20,20),Colors.Blue);
            int right=Compact?Width-64:hovered?Connect.Left-10:Width-64;string label=Preference.label.Length>0?Preference.label:new Uri(Target.Url).Host;
            using(var f=new Font(Font,FontStyle.Bold))PaintUi.Text(g,label,f,new Rectangle(96,24,Math.Max(20,right-96),26),Colors.Text);
            PaintUi.Text(g,Target.Url,Font,new Rectangle(96,51,Math.Max(20,right-96),24),Colors.Blue);
            if(Compact){PaintUi.Text(g,LocalState.Caption(Target.State),Font,new Rectangle(48,85,Math.Max(10,Connect.Left-60),30),Target.State=="connected"?Colors.Success:Colors.Muted);}else if(!hovered){PaintUi.Text(g,LocalState.Caption(Target.State),Font,new Rectangle(Width-216,31,156,30),Target.State=="connected"?Colors.Success:Colors.Muted,true);}
            if(Expanded)using(var p=new Pen(Colors.Border))g.DrawLine(p,17,HeaderHeight-10,Width-17,HeaderHeight-10);
        }
        protected override void Dispose(bool disposing){if(disposing){hoverTimer.Stop();hoverTimer.Dispose();animation.Stop();animation.Dispose();tips.Dispose();if(icon!=null)icon.Dispose();}base.Dispose(disposing);}
    }
    internal sealed class TargetEditor : Form {
        readonly TextBox label=new TextBox(),url=new TextBox();readonly PictureBox image=new PictureBox();readonly Label error=new Label();
        internal string DisplayName {get{return label.Text.Trim();}} internal string Url {get{return url.Text.Trim();}} internal string IconData;
        internal TargetEditor(Target target,CardPreference preference,Palette colors){
            Text="编辑云电脑";Font=new Font("Microsoft YaHei UI",9F);AutoScaleMode=AutoScaleMode.Dpi;ClientSize=new Size(500,345);MinimumSize=MaximumSize=Size;FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=MinimizeBox=false;StartPosition=FormStartPosition.CenterParent;BackColor=colors.Surface;ForeColor=colors.Text;
            IconData=preference.icon;label.Text=preference.label;label.MaxLength=80;url.Text=target.Url;url.MaxLength=300;
            Controls.Add(new Label{Text="名称 / 备注",Bounds=new Rectangle(24,22,200,24)});label.Bounds=new Rectangle(24,50,452,28);Controls.Add(label);
            Controls.Add(new Label{Text="云电脑地址",Bounds=new Rectangle(24,94,200,24)});url.Bounds=new Rectangle(24,122,452,28);Controls.Add(url);
            Controls.Add(new Label{Text="项目图标",Bounds=new Rectangle(24,167,100,24)});image.Bounds=new Rectangle(25,198,48,48);image.SizeMode=PictureBoxSizeMode.Zoom;Controls.Add(image);RefreshIcon();
            var choose=new Button{Text="选择图片…",Bounds=new Rectangle(91,204,110,30)};choose.Click+=delegate{using(var picker=new OpenFileDialog{Filter="图标图片 (*.png;*.jpg;*.jpeg;*.ico)|*.png;*.jpg;*.jpeg;*.ico",CheckFileExists=true}){if(picker.ShowDialog(this)!=DialogResult.OK)return;try{IconData=UiPreferences.ImportIcon(picker.FileName);RefreshIcon();error.Text="";}catch(Exception ex){error.Text=ex.Message;}}};Controls.Add(choose);
            var reset=new Button{Text="恢复默认",Bounds=new Rectangle(212,204,100,30)};reset.Click+=delegate{IconData="";RefreshIcon();};Controls.Add(reset);
            error.Bounds=new Rectangle(24,252,452,40);error.ForeColor=colors.Danger;Controls.Add(error);
            Button save=new Button{Text="保存",Bounds=new Rectangle(280,300,92,30)},cancel=new Button{Text="取消",DialogResult=DialogResult.Cancel,Bounds=new Rectangle(384,300,92,30)};Controls.AddRange(new Control[]{save,cancel});AcceptButton=save;CancelButton=cancel;
            save.Click+=delegate{Uri parsed;if(DisplayName.Any(Char.IsControl)){error.Text="名称不能包含控制字符。";return;}if(!Uri.TryCreate(Url,UriKind.Absolute,out parsed)||parsed.Scheme!="https"||parsed.UserInfo.Length>0||parsed.AbsolutePath!="/"||parsed.Query.Length>0||parsed.Fragment.Length>0){error.Text="请输入完整的 HTTPS 云电脑地址，不含路径或登录信息。";return;}DialogResult=DialogResult.OK;Close();};
            foreach(var box in new[]{label,url}){box.BackColor=colors.Subtle;box.ForeColor=colors.Text;box.BorderStyle=BorderStyle.FixedSingle;}
        }
        void RefreshIcon(){var previous=image.Image;image.Image=IconData.Length==0?null:UiPreferences.DecodeIcon(IconData);if(previous!=null)previous.Dispose();}
        protected override void Dispose(bool disposing){if(disposing&&image.Image!=null){image.Image.Dispose();image.Image=null;}base.Dispose(disposing);}
    }
}
