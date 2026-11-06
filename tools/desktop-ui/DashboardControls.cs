using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    // Text follows the monitor the window is on. Point sizes resolve against the system
    // DPI on every monitor, so Scale (window DPI / system DPI) corrects them. Layout stays in pixels.
    internal static class UiFont {
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetDpiForSystem();
        internal static float Scale=1;
        internal static int SystemDpi {get{try{return (int)GetDpiForSystem();}catch(EntryPointNotFoundException){return 0;}}}
        internal static float ScaleFor(int dpi){int system=SystemDpi;return system>0&&dpi>0?dpi/(float)system:1;}
        internal static Font Points(float size){return new Font("Microsoft YaHei UI",size*Scale);}
        internal static void Rescale(Control root,float factor){
            var all=new System.Collections.Generic.List<Control>();var old=new System.Collections.Generic.List<Font>();
            Action<Control> visit=null;visit=c=>{all.Add(c);old.Add(c.Font);foreach(Control child in c.Controls)visit(child);};visit(root);
            var made=new System.Collections.Generic.Dictionary<string,Font>();
            for(int i=0;i<all.Count;i++){
                var f=old[i];string key=f.Name+"|"+f.Size+"|"+f.Style;Font next;
                if(!made.TryGetValue(key,out next)){next=new Font(f.FontFamily,f.Size*factor,f.Style);made[key]=next;}
                all[i].Font=next;
            }
        }
    }
    internal sealed class Palette {
        internal bool Dark;
        internal Color Page, Surface, Subtle, Border, Text, Muted, Blue, Selected, SelectionBorder, Danger, Success;
        internal const int Gap = 16, Radius = 15, Header = 116;
        internal Color Side { get { return Dark ? Color.FromArgb(16,18,21) : Subtle; } }
        internal Color Active { get { return Dark ? Color.FromArgb(38,41,47) : Color.FromArgb(233,237,243); } }
        internal Color Track { get { return Dark ? Color.FromArgb(74,78,87) : Color.FromArgb(201,206,216); } }
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
                    case "back": g.DrawLines(p,new Point[]{new Point(12,5),new Point(5,12),new Point(12,19)});g.DrawLine(p,5,12,21,12);break;
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
                    case "settings":{
                        var outline=new System.Collections.Generic.List<PointF>();
                        for(int i=0;i<8;i++){double a=i*Math.PI/4;foreach(var step in new[]{new[]{-0.28,7.7},new[]{-0.15,10.6},new[]{0.15,10.6},new[]{0.28,7.7}})outline.Add(new PointF(12+(float)(Math.Cos(a+step[0])*step[1]),12+(float)(Math.Sin(a+step[0])*step[1])));}
                        g.DrawPolygon(p,outline.ToArray());g.DrawEllipse(p,8.6f,8.6f,6.8f,6.8f);break;}
                    case "profile":using(var path=Round(new Rectangle(2,5,20,15),2))g.DrawPath(p,path);g.DrawEllipse(p,5,8,4,4);g.DrawArc(p,4,14,6,5,180,180);g.DrawLine(p,13,9,19,9);g.DrawLine(p,13,12,19,12);g.DrawLine(p,13,16,17,16);break;
                    case "sliders":g.DrawLine(p,4,7,14,7);g.DrawLine(p,18,7,20,7);g.DrawLine(p,4,17,6,17);g.DrawLine(p,10,17,20,17);g.DrawEllipse(p,14,5,4,4);g.DrawEllipse(p,6,15,4,4);break;
                    case "link":{var turn=g.Save();g.TranslateTransform(12,12);g.RotateTransform(-45);using(var a=Round(new Rectangle(-10,-4,11,8),4))g.DrawPath(p,a);using(var b=Round(new Rectangle(-1,-4,11,8),4))g.DrawPath(p,b);g.Restore(turn);break;}
                    case "globe":g.DrawEllipse(p,3,3,18,18);g.DrawLine(p,3,12,21,12);g.DrawEllipse(p,8,3,8,18);break;
                    case "info":g.DrawEllipse(p,3,3,18,18);g.DrawLine(p,12,11,12,16);using(var b=new SolidBrush(color))g.FillEllipse(b,11,7,2,2);break;
                    case "sun":g.DrawEllipse(p,8,8,8,8);for(int i=0;i<8;i++){double a=i*Math.PI/4;g.DrawLine(p,12+(float)Math.Cos(a)*7.5f,12+(float)Math.Sin(a)*7.5f,12+(float)Math.Cos(a)*10,12+(float)Math.Sin(a)*10);}break;
                    case "moon":using(var path=new GraphicsPath()){path.AddArc(3.62f,3.62f,16.76f,16.76f,17.35f,235.3f);path.AddArc(7.32f,1.82f,14.86f,14.86f,225f,-180f);path.CloseFigure();g.DrawPath(p,path);}break;
                    case "terminal":g.DrawRectangle(p,3,5,18,14);g.DrawLines(p,new Point[]{new Point(7,9),new Point(10,12),new Point(7,15)});g.DrawLine(p,13,15,17,15);break;
                    case "swap":g.DrawLine(p,5,8,19,8);g.DrawLines(p,new Point[]{new Point(15,4),new Point(19,8),new Point(15,12)});g.DrawLine(p,19,16,5,16);g.DrawLines(p,new Point[]{new Point(9,12),new Point(5,16),new Point(9,20)});break;
                    case "grip":using(var b=new SolidBrush(color))for(int y=5;y<=19;y+=7)for(int x=8;x<=15;x+=7)g.FillEllipse(b,x-1,y-1,2,2);break;
                    default:g.DrawEllipse(p,4,4,16,16);g.DrawLine(p,12,8,12,13);g.DrawEllipse(p,11,16,1,1);break;
                }
            } g.Restore(old);
        }
    }
    internal sealed class ModernButton : Control, IButtonControl {
        internal Palette Colors=Palette.Create(false);
        internal string Glyph="";
        internal int TextOffsetX;
        internal bool Primary, Neutral, Destructive, CenterText, Segment, Nav, Dot, DotOk;
        bool hover, pressed;
        // One shared timer: the pointer often leaves one button as it enters the next.
        const double FadeMilliseconds=110;
        static readonly System.Collections.Generic.List<ModernButton> fading=new System.Collections.Generic.List<ModernButton>();
        static readonly System.Windows.Forms.Timer fadeTimer=CreateFadeTimer();
        readonly System.Diagnostics.Stopwatch fadeClock=new System.Diagnostics.Stopwatch(),selectClock=new System.Diagnostics.Stopwatch();
        double hoverLevel,fadeFrom,selectLevel,selectFrom;
        bool selected;
        // A segment of a rounded group: its blue background fades between the options.
        internal bool Selected{get{return selected;}set{
            if(selected==value)return;
            selected=value;
            if(!Motion.Enabled||!IsHandleCreated||!Visible){selectLevel=value?1:0;selectClock.Stop();Invalidate();return;}
            selectFrom=selectLevel;selectClock.Restart();StartFade();
        }}
        void StartFade(){if(!fading.Contains(this))fading.Add(this);fadeTimer.Start();}
        static System.Windows.Forms.Timer CreateFadeTimer(){var timer=new System.Windows.Forms.Timer{Interval=15};timer.Tick+=delegate{foreach(var button in fading.ToArray())button.AdvanceFade();if(fading.Count==0)timer.Stop();};return timer;}
        void SetHover(bool value){
            hover=value;
            if(!Motion.Enabled||!IsHandleCreated||!Visible){hoverLevel=value?1:0;fadeClock.Stop();Invalidate();return;}
            fadeFrom=hoverLevel;fadeClock.Restart();StartFade();
        }
        static double Faded(System.Diagnostics.Stopwatch clock,double from,double goal,ref bool moving){
            if(!clock.IsRunning)return goal;
            double t=clock.ElapsedMilliseconds/FadeMilliseconds;
            if(t>=1){clock.Stop();return goal;}
            moving=true;return from+(goal-from)*Motion.EaseOut(t);
        }
        void AdvanceFade(){
            bool moving=false;
            hoverLevel=Faded(fadeClock,fadeFrom,hover?1:0,ref moving);selectLevel=Faded(selectClock,selectFrom,selected?1:0,ref moving);
            if(!moving)fading.Remove(this);
            Invalidate();
        }
        protected override void Dispose(bool disposing){if(disposing)fading.Remove(this);base.Dispose(disposing);}
        internal ModernButton() {
            Size=new Size(32,32); Cursor=Cursors.Hand;TabStop=true;AccessibleRole=AccessibleRole.PushButton;
            SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Selectable|ControlStyles.StandardClick,true);
        }
        public DialogResult DialogResult{get;set;}
        public void NotifyDefault(bool value){}
        public void PerformClick(){if(Enabled)OnClick(EventArgs.Empty);}
        sealed class ButtonAccessibility : ControlAccessibleObject {
            readonly ModernButton button;
            internal ButtonAccessibility(ModernButton value):base(value){button=value;}
            public override string Name{get{return L.Text(button.AccessibleName??button.Text);}set{button.AccessibleName=value;}}
            public override string DefaultAction{get{return "Press";}}
            public override void DoDefaultAction(){button.PerformClick();}
        }
        protected override AccessibleObject CreateAccessibilityInstance(){return new ButtonAccessibility(this);}
        protected override void OnKeyDown(KeyEventArgs e){if(e.KeyCode==Keys.Space||e.KeyCode==Keys.Enter){pressed=true;e.Handled=true;Invalidate();}base.OnKeyDown(e);}
        protected override void OnKeyUp(KeyEventArgs e){if((e.KeyCode==Keys.Space||e.KeyCode==Keys.Enter)&&pressed){pressed=false;e.Handled=true;PerformClick();Invalidate();}base.OnKeyUp(e);}
        protected override void OnGotFocus(EventArgs e){base.OnGotFocus(e);Invalidate();}
        protected override void OnLostFocus(EventArgs e){pressed=false;base.OnLostFocus(e);Invalidate();}
        protected override void OnMouseEnter(EventArgs e){SetHover(true);base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){pressed=false;SetHover(false);Invalidate();base.OnMouseLeave(e);}
        protected override void OnMouseDown(MouseEventArgs e){pressed=true;Invalidate();base.OnMouseDown(e);}
        protected override void OnMouseUp(MouseEventArgs e){pressed=false;Invalidate();base.OnMouseUp(e);}
        protected override void OnPaint(PaintEventArgs e) {
            var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;
            Color bg=Primary?Colors.Blue:Neutral?Colors.Subtle:BackColor;
            if(Enabled)bg=Motion.Mix(bg,Primary?ControlPaint.Dark(Colors.Blue,0.08f):Colors.Subtle,hoverLevel);
            if(Segment)bg=Motion.Mix(Motion.Mix(BackColor,Colors.Subtle,hoverLevel),Colors.Blue,selectLevel);
            if(Nav)bg=Motion.Mix(Motion.Mix(BackColor,Colors.Active,hoverLevel*0.6),Colors.Active,selectLevel);
            if(pressed && Enabled)bg=ControlPaint.Dark(bg,0.06f);
            Color fg=!Enabled?Colors.Muted:Primary?Color.White:Destructive?Colors.Danger:Colors.Text;
            if(Segment&&Enabled)fg=Motion.Mix(Colors.Text,Color.White,selectLevel);
            using(var b=new SolidBrush(BackColor))g.FillRectangle(b,ClientRectangle);
            PaintUi.Box(g,new Rectangle(1,1,Math.Max(1,Width-3),Math.Max(1,Height-3)),8,bg,Destructive&&Text.Length>0?fg:bg);
            int glyphSize=Height>=40?22:20, x=Text.Length==0?(Width-glyphSize)/2:12;
            if(Glyph.Length>0)PaintUi.Icon(g,Glyph,new Rectangle(x,(Height-glyphSize)/2,glyphSize,glyphSize),fg);
            if(Text.Length>0){if(CenterText)TextRenderer.DrawText(g,L.Text(Text),Font,ClientRectangle,fg,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);else PaintUi.Text(g,L.Text(Text),Font,new Rectangle((Glyph.Length>0?39:10)+TextOffsetX,0,Width-(Glyph.Length>0?44:20)-TextOffsetX,Height),fg);}
            if(Dot)using(var b=new SolidBrush(DotOk?Colors.Success:Colors.Danger))g.FillEllipse(b,Width-(Nav?22:13),Nav?(Height-8)/2:5,8,8);
            if(Focused&&ShowFocusCues)using(var path=PaintUi.Round(new Rectangle(2,2,Width-5,Height-5),8))using(var p=new Pen(Colors.SelectionBorder))g.DrawPath(p,path);
        }
    }
    internal sealed class DashboardToolbar : Panel {
        internal readonly ModernButton Settings=new ModernButton { Glyph="settings",Neutral=true,AccessibleName="设置" }, Add=new ModernButton { Glyph="plus",Text="添加设备",Primary=true,AccessibleName="添加设备",TextOffsetX=4 };
        internal readonly UpdateProgressRing Progress=new UpdateProgressRing();
        readonly LocalToolTip tips=new LocalToolTip();
        internal Palette Colors=Palette.Create(false);
        internal DashboardToolbar() {
            Height=72;Dock=DockStyle.Top;DoubleBuffered=true;Font=new Font("Microsoft YaHei UI",9F);
            Controls.AddRange(new Control[]{Settings,Add,Progress});
        }
        internal void SetUpdateDot(bool available){if(Settings.Dot==available)return;Settings.Dot=available;Settings.AccessibleDescription=available?L.Text("有可用更新"):null;Settings.Invalidate();}
        internal void Apply(Palette colors){Colors=colors;tips.Apply(colors);BackColor=colors.Surface;Progress.Apply(colors);foreach(ModernButton b in Controls.OfType<ModernButton>()){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}Invalidate();}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);Settings.Bounds=new Rectangle(160,16,40,40);Progress.Bounds=new Rectangle(216,16,40,40);Add.Bounds=new Rectangle(Width-176,16,148,40);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;using(var f=new Font(Font.FontFamily,14*UiFont.Scale,FontStyle.Bold))PaintUi.Text(e.Graphics,"CMCP",f,new Rectangle(28,17,124,36),Colors.Blue);using(var p=new Pen(Colors.Border))e.Graphics.DrawLine(p,0,Height-1,Width,Height-1);}
        protected override void Dispose(bool disposing){if(disposing)tips.Dispose();base.Dispose(disposing);}
    }
    internal sealed class ConnectionDetails : Panel {
        internal Target Target;
        internal string StatusOverride="";
        // Set only while the card is in SSH mode. The web connection underneath keeps running.
        internal SshLogin Ssh;
        internal bool SshMode;
        internal string Note="";
        internal Palette Colors=Palette.Create(false);
        internal readonly ModernButton Open=new ModernButton{Glyph="monitor",Text="打开云电脑"}, Stop=new ModernButton{Glyph="stop",Text="停止连接",Destructive=true}, Logs=new ModernButton{Text="查看日志"};
        internal ConnectionDetails(){DoubleBuffered=true;Controls.AddRange(new Control[]{Open,Stop,Logs});}
        internal void Apply(Palette colors){Colors=colors;BackColor=colors.Surface;foreach(ModernButton b in Controls){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}Invalidate();}
        int ClientRows{get{return !SshMode&&Target!=null&&(Target.DesktopClient!=null||Target.CliClient!=null)?60:0;}}
        void ClientRow(Graphics g,string label,bool? running,int y){string value=LocalState.ClientState(Target.State,running==true);PaintUi.Text(g,label,Font,new Rectangle(18,y,190,24),Colors.Muted);PaintUi.Text(g,L.Text(value),Font,new Rectangle(130,y,Width-148,24),value=="已连接"?Colors.Success:Colors.Text,true);}
        string Body{get{
            if(Target==null)return "";
            string text=!SshMode?L.Message(Target.Detail??""):L.Text("点击“打开终端”，用设置里选定的终端连接这台设备。SSH 不经过 MCP 连接。")+(Target.Url.Length>0&&Target.State!="stopped"?"\r\n"+L.Text("共享网页连接")+"："+L.Text(LocalState.Caption(Target.State)):"");
            return text;
        }}
        internal int NeededHeight(int width){return 164+ClientRows+TextRenderer.MeasureText(Body,Font,new Size(Math.Max(100,width-44),1000),TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix).Height;}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);Open.Bounds=new Rectangle(14,Height-54,164,40);Stop.Bounds=new Rectangle(185,Height-54,144,40);Logs.Bounds=new Rectangle(Stop.Visible?336:185,Height-54,140,40);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Target==null)return;var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;PaintUi.Box(g,new Rectangle(0,0,Width-1,Height-1),11,Colors.Surface,Colors.Border);
            PaintUi.Text(g,L.Text(SshMode?"SSH 地址":"连接状态"),Font,new Rectangle(18,10,100,24),Colors.Muted);PaintUi.Text(g,SshMode?(Ssh==null?"":Ssh.Address):StatusOverride.Length>0?L.Text(StatusOverride):L.Text(LocalState.Caption(Target.State)),Font,new Rectangle(130,10,Width-148,24),!SshMode&&Target.State=="connected"?Colors.Success:Colors.Text,true);
            PaintUi.Text(g,L.Text("登录方式"),Font,new Rectangle(18,40,100,24),Colors.Muted);PaintUi.Text(g,SshMode?(Ssh==null?"SSH":"SSH · "+L.Text(Ssh.UsesKey?"公钥":"密码")):Target.Url.Length==0?L.Text("共享网页"):L.Text(Target.Mode),Font,new Rectangle(130,40,Width-148,24),Colors.Text,true);
            int rows=ClientRows;if(rows>0){ClientRow(g,"Claude Desktop",Target.DesktopClient,70);ClientRow(g,"CLI",Target.CliClient,100);}
            using(var p=new Pen(Colors.Border))g.DrawLine(p,18,76+rows,Width-18,76+rows);
            TextRenderer.DrawText(g,Body,Font,new Rectangle(18,88+rows,Width-36,Height-153-rows),Colors.Muted,TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix);
        }
    }
}
