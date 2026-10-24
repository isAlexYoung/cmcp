using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class Palette {
        internal bool Dark;
        internal Color Page, Surface, Subtle, Border, Text, Muted, Blue, Selected, SelectionBorder, Danger, Success;
        internal const int Gap = 16, Radius = 15, Header = 116;
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
                    case "settings":g.DrawEllipse(p,5,5,14,14);g.DrawEllipse(p,9,9,6,6);for(int i=0;i<8;i++){double a=i*Math.PI/4;g.DrawLine(p,12+(float)Math.Cos(a)*8,12+(float)Math.Sin(a)*8,12+(float)Math.Cos(a)*11,12+(float)Math.Sin(a)*11);}break;
                    case "grip":using(var b=new SolidBrush(color))for(int y=5;y<=19;y+=7)for(int x=8;x<=15;x+=7)g.FillEllipse(b,x-1,y-1,2,2);break;
                    default:g.DrawEllipse(p,4,4,16,16);g.DrawLine(p,12,8,12,13);g.DrawEllipse(p,11,16,1,1);break;
                }
            } g.Restore(old);
        }
    }
    internal sealed class ModernButton : Control, IButtonControl {
        internal Palette Colors=Palette.Create(false);
        internal string Glyph="";
        internal bool Primary, Neutral, Destructive, CenterText;
        bool hover, pressed;
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
            int glyphSize=Height>=40?22:20, x=Text.Length==0?(Width-glyphSize)/2:12;
            if(Glyph.Length>0)PaintUi.Icon(g,Glyph,new Rectangle(x,(Height-glyphSize)/2,glyphSize,glyphSize),fg);
            if(Text.Length>0){if(CenterText)TextRenderer.DrawText(g,L.Text(Text),Font,ClientRectangle,fg,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);else PaintUi.Text(g,L.Text(Text),Font,new Rectangle(Glyph.Length>0?39:10,0,Width-(Glyph.Length>0?44:20),Height),fg);}
            if(Focused&&ShowFocusCues)using(var path=PaintUi.Round(new Rectangle(2,2,Width-5,Height-5),8))using(var p=new Pen(Colors.SelectionBorder))g.DrawPath(p,path);
        }
    }
    internal sealed class DashboardToolbar : Panel {
        internal readonly ModernButton Settings=new ModernButton { Glyph="settings",AccessibleName="设置" }, UpdateButton=new ModernButton { Glyph="refresh",AccessibleName="检查更新" }, Theme=new ModernButton { Glyph="theme",AccessibleName="切换浅色或深色" }, Add=new ModernButton { Glyph="plus",Text="添加云电脑",Primary=true,AccessibleName="添加云电脑" };
        readonly LocalToolTip tips=new LocalToolTip();
        internal Palette Colors=Palette.Create(false);
        internal DashboardToolbar() {
            Height=72;Dock=DockStyle.Top;DoubleBuffered=true;Font=new Font("Microsoft YaHei UI",9F);
            Controls.AddRange(new Control[]{Settings,UpdateButton,Theme,Add});
            tips.SetToolTip(Settings,"设置");tips.SetToolTip(UpdateButton,"检查更新");tips.SetToolTip(Theme,"切换浅色 / 深色主题");tips.SetToolTip(Add,"添加新的云电脑，不会自动连接");
        }
        internal void UpdateTip(string value){tips.SetToolTip(UpdateButton,value);UpdateButton.AccessibleDescription=L.Text(value);}
        internal void Apply(Palette colors){Colors=colors;BackColor=colors.Surface;foreach(ModernButton b in Controls){b.Colors=colors;b.BackColor=b==Settings||b==UpdateButton?colors.Subtle:colors.Surface;b.Invalidate();}Invalidate();}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);Settings.Bounds=new Rectangle(166,20,32,32);UpdateButton.Bounds=new Rectangle(204,20,32,32);Theme.Bounds=new Rectangle(Width-231,17,40,40);Add.Bounds=new Rectangle(Width-176,16,148,40);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;PaintUi.Box(e.Graphics,new Rectangle(160,16,82,40),10,Colors.Subtle,Colors.Subtle);using(var f=new Font(Font.FontFamily,14,FontStyle.Bold))PaintUi.Text(e.Graphics,"CMCP",f,new Rectangle(28,17,124,36),Colors.Blue);using(var p=new Pen(Colors.Border))e.Graphics.DrawLine(p,0,Height-1,Width,Height-1);}
        protected override void Dispose(bool disposing){if(disposing)tips.Dispose();base.Dispose(disposing);}
    }
    internal sealed class ConnectionDetails : Panel {
        internal Target Target;
        internal string StatusOverride="";
        internal Palette Colors=Palette.Create(false);
        internal readonly ModernButton Open=new ModernButton{Glyph="monitor",Text="打开云电脑"}, Stop=new ModernButton{Glyph="stop",Text="停止连接",Destructive=true}, Logs=new ModernButton{Text="查看日志"};
        internal ConnectionDetails(){DoubleBuffered=true;Controls.AddRange(new Control[]{Open,Stop,Logs});}
        internal void Apply(Palette colors){Colors=colors;BackColor=colors.Surface;foreach(ModernButton b in Controls){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}Invalidate();}
        internal int NeededHeight(int width){return 164+TextRenderer.MeasureText(Target==null?"":L.Message(Target.Detail),Font,new Size(Math.Max(100,width-44),1000),TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix).Height;}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);Open.Bounds=new Rectangle(14,Height-54,164,40);Stop.Bounds=new Rectangle(185,Height-54,144,40);Logs.Bounds=new Rectangle(336,Height-54,140,40);}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Target==null)return;var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;PaintUi.Box(g,new Rectangle(0,0,Width-1,Height-1),11,Colors.Surface,Colors.Border);
            PaintUi.Text(g,L.Text("连接状态"),Font,new Rectangle(18,10,100,24),Colors.Muted);PaintUi.Text(g,StatusOverride.Length>0?L.Text(StatusOverride):L.Text(LocalState.Caption(Target.State)),Font,new Rectangle(130,10,Width-148,24),Target.State=="connected"?Colors.Success:Colors.Text,true);
            PaintUi.Text(g,L.Text("登录方式"),Font,new Rectangle(18,40,100,24),Colors.Muted);PaintUi.Text(g,L.Text(Target.Mode),Font,new Rectangle(130,40,Width-148,24),Colors.Text,true);
            using(var p=new Pen(Colors.Border))g.DrawLine(p,18,76,Width-18,76);
            TextRenderer.DrawText(g,L.Message(Target.Detail),Font,new Rectangle(18,88,Width-36,Height-153),Colors.Muted,TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix);
        }
    }
}
