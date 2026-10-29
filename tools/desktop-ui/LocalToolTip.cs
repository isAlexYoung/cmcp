using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CMCP {
    // A passive popup uses the application's palette instead of the Windows
    // tooltip theme. It never activates or takes keyboard focus from the owner.
    internal sealed class LocalToolTip : Component {
        readonly Dictionary<Control,string> source=new Dictionary<Control,string>();
        readonly Timer delay=new Timer();
        Palette colors=Palette.Create(false);
        Control current;
        Form owner;
        TipWindow popup;
        bool waiting,disposed;
        internal LocalToolTip(){delay.Tick+=Tick;L.Changed+=RefreshLanguage;}
        internal void SetToolTip(Control control,string text){
            if(disposed||control.IsDisposed)return;
            if(!source.ContainsKey(control)){
                control.MouseEnter+=Enter;control.MouseMove+=Move;control.MouseLeave+=Leave;
                control.MouseDown+=Dismiss;control.KeyDown+=Key;control.Disposed+=Remove;
            }
            string previous;bool changed=!source.TryGetValue(control,out previous)||previous!=text;
            source[control]=text;
            if(changed&&current==control&&popup!=null&&popup.Visible)Present();
        }
        internal void Apply(Palette value){
            bool changed=colors.Dark!=value.Dark;colors=value;
            if(changed&&popup!=null)popup.Apply(colors);
        }
        void Enter(object sender,EventArgs e){Arm((Control)sender);}
        void Move(object sender,MouseEventArgs e){if(current!=sender)Arm((Control)sender);}
        void Leave(object sender,EventArgs e){if(current==sender)Hide();}
        void Dismiss(object sender,MouseEventArgs e){Hide();}
        void Key(object sender,KeyEventArgs e){Hide();}
        void Remove(object sender,EventArgs e){var control=(Control)sender;if(current==control)Hide();Unhook(control);source.Remove(control);}
        void Unhook(Control control){control.MouseEnter-=Enter;control.MouseMove-=Move;control.MouseLeave-=Leave;control.MouseDown-=Dismiss;control.KeyDown-=Key;control.Disposed-=Remove;}
        void Arm(Control control){
            string text;if(!source.TryGetValue(control,out text)||String.IsNullOrEmpty(text))return;
            Hide();current=control;waiting=true;delay.Interval=450;delay.Start();
        }
        void Tick(object sender,EventArgs e){
            delay.Stop();if(!waiting){Hide();return;}
            waiting=false;if(Present()){delay.Interval=8000;delay.Start();}
        }
        void OwnerChanged(object sender,EventArgs e){Hide();}
        void BindOwner(Form value){
            if(owner==value)return;
            if(owner!=null){owner.Deactivate-=OwnerChanged;owner.LocationChanged-=OwnerChanged;owner.ResizeBegin-=OwnerChanged;}
            owner=value;
            if(owner!=null){owner.Deactivate+=OwnerChanged;owner.LocationChanged+=OwnerChanged;owner.ResizeBegin+=OwnerChanged;}
        }
        bool Present(){
            if(disposed||current==null||current.IsDisposed||!current.Visible||!current.Enabled)return false;
            var form=current.FindForm();if(form==null||!form.ContainsFocus)return false;
            if(!current.RectangleToScreen(current.ClientRectangle).Contains(Cursor.Position))return false;
            BindOwner(form);
            using(var scope=new TrayDisplay.Scope()){
                if(popup==null||popup.IsDisposed)popup=new TipWindow();
                var point=TrayDisplay.Pointer();
                TrayDisplay.Move(popup,new Point(point.X+12,point.Y+20));
                popup.SetContent(L.Text(source[current]),colors);
                var area=TrayDisplay.WorkingArea(point);
                var at=new Point(Math.Max(area.Left,Math.Min(point.X+12,area.Right-popup.Width)),point.Y+20);
                if(at.Y+popup.Height>area.Bottom)at.Y=point.Y-popup.Height-10;
                at.Y=Math.Max(area.Top,at.Y);
                TrayDisplay.Move(popup,at);if(!popup.Visible)popup.Show(form);else popup.Invalidate();
            }
            return true;
        }
        void RefreshLanguage(){if(popup!=null&&popup.Visible)Present();}
        internal void Hide(){delay.Stop();waiting=false;current=null;if(popup!=null)popup.Hide();}
        protected override void Dispose(bool disposing){
            if(disposing&&!disposed){disposed=true;Hide();BindOwner(null);delay.Dispose();L.Changed-=RefreshLanguage;foreach(var control in source.Keys.ToArray())Unhook(control);source.Clear();if(popup!=null)popup.Dispose();}
            base.Dispose(disposing);
        }

        internal sealed class TipWindow : Form {
            [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr window);
            Palette colors=Palette.Create(false);
            string content="";
            float scale=1;
            int padX=12,padY=8;
            Font ownedFont;
            readonly StringFormat format=new StringFormat(StringFormat.GenericDefault){Trimming=StringTrimming.None};
            internal TipWindow(){FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;AutoScaleMode=AutoScaleMode.None;DoubleBuffered=true;AccessibleRole=AccessibleRole.ToolTip;SetStyle(ControlStyles.Selectable,false);}
            protected override bool ShowWithoutActivation {get{return true;}}
            protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x00000080|0x00000020;p.ClassStyle|=0x00020000;return p;}}
            internal void Apply(Palette value){colors=value;BackColor=value.Subtle;ForeColor=value.Text;Invalidate();}
            internal void SetContent(string text,Palette value){
                content=text;AccessibleName=text;Apply(value);
                try{scale=Math.Max(1,GetDpiForWindow(Handle)/96f);}catch(EntryPointNotFoundException){using(var g=CreateGraphics())scale=g.DpiX/96f;}
                padX=(int)Math.Round(12*scale);padY=(int)Math.Round(8*scale);
                // Control.Font keeps its existing object when an equal font is
                // assigned. Reuse that object instead of disposing a live font.
                if(ownedFont==null||Math.Abs(ownedFont.Size-14*scale)>0.01f){var previous=ownedFont;ownedFont=new Font("Microsoft YaHei UI",14*scale,FontStyle.Regular,GraphicsUnit.Pixel);Font=ownedFont;if(previous!=null)previous.Dispose();}
                using(var g=CreateGraphics()){
                    g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;
                    var measured=g.MeasureString(content,Font,(int)(420*scale),format);
                    ClientSize=new Size((int)Math.Ceiling(measured.Width)+2*padX+2,(int)Math.Ceiling(measured.Height)+2*padY+2);
                }
                using(var path=PaintUi.Round(new Rectangle(0,0,Width,Height),(int)(10*scale))){var old=Region;Region=new Region(path);if(old!=null)old.Dispose();}
                Invalidate();
            }
            protected override void OnPaint(PaintEventArgs e){
                e.Graphics.Clear(colors.Subtle);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
                PaintUi.Box(e.Graphics,new Rectangle(0,0,Width-1,Height-1),(int)(10*scale),colors.Subtle,colors.Border);
                e.Graphics.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;
                using(var brush=new SolidBrush(colors.Text))e.Graphics.DrawString(content,Font,brush,new RectangleF(padX,padY,Width-2*padX,Height-2*padY),format);
            }
            protected override void Dispose(bool disposing){if(disposing&&!IsDisposed){format.Dispose();Font=Control.DefaultFont;if(ownedFont!=null){ownedFont.Dispose();ownedFont=null;}}base.Dispose(disposing);}
        }
    }
}
