using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CMCP {
    internal static class TrayDisplay {
        [StructLayout(LayoutKind.Sequential)]struct NativePoint {public int X,Y;}
        [StructLayout(LayoutKind.Sequential)]struct NativeRect {public int Left,Top,Right,Bottom;internal Rectangle Rectangle{get{return System.Drawing.Rectangle.FromLTRB(Left,Top,Right,Bottom);}}}
        [StructLayout(LayoutKind.Sequential)]struct MonitorInfo {public int Size;public NativeRect Monitor,Work;public int Flags;}
        [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")]static extern IntPtr GetThreadDpiAwarenessContext();
        [DllImport("user32.dll")]static extern bool GetPhysicalCursorPos(out NativePoint point);
        [DllImport("user32.dll")]static extern IntPtr MonitorFromPoint(NativePoint point,int flags);
        [DllImport("user32.dll")]static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
        [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out NativeRect bounds);
        [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
        [DllImport("shcore.dll")]static extern int GetDpiForMonitor(IntPtr monitor,int type,out uint x,out uint y);
        internal sealed class Scope : IDisposable {
            readonly IntPtr previous;
            internal bool Physical {get{return previous!=IntPtr.Zero;}}
            internal Scope(){try{previous=SetThreadDpiAwarenessContext(new IntPtr(-4));if(previous==IntPtr.Zero)previous=SetThreadDpiAwarenessContext(new IntPtr(-3));}catch(EntryPointNotFoundException){}catch(DllNotFoundException){}}
            internal Scope(IntPtr context){if(context!=IntPtr.Zero)try{previous=SetThreadDpiAwarenessContext(context);}catch(EntryPointNotFoundException){}catch(DllNotFoundException){}}
            public void Dispose(){if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
        }
        internal static IntPtr Context {get{try{return GetThreadDpiAwarenessContext();}catch(EntryPointNotFoundException){return IntPtr.Zero;}catch(DllNotFoundException){return IntPtr.Zero;}}}
        internal static Point Pointer(){using(var scope=new Scope()){NativePoint point;if(scope.Physical&&GetPhysicalCursorPos(out point))return new Point(point.X,point.Y);return Cursor.Position;}}
        internal static Rectangle WorkingArea(Point point){using(var scope=new Scope()){
            var info=new MonitorInfo{Size=Marshal.SizeOf(typeof(MonitorInfo))};
            if(scope.Physical&&GetMonitorInfo(MonitorFromPoint(new NativePoint{X=point.X,Y=point.Y},2),ref info))return info.Work.Rectangle;
            return Screen.FromPoint(point).WorkingArea;
        }}
        // The display scale where the menu opens, so its rows, fonts and icons match that monitor.
        internal static float Scale(Point point){using(var scope=new TrayDisplay.Scope()){
            try{uint x,y;if(scope.Physical&&GetDpiForMonitor(MonitorFromPoint(new NativePoint{X=point.X,Y=point.Y},2),0,out x,out y)==0&&x>0)return x/96f;}
            catch(EntryPointNotFoundException){}catch(DllNotFoundException){}
            using(var graphics=Graphics.FromHwnd(IntPtr.Zero))return graphics.DpiX/96f;
        }}
        internal static Rectangle Bounds(Control control){using(var scope=new Scope()){NativeRect rect;if(scope.Physical&&GetWindowRect(control.Handle,out rect))return rect.Rectangle;return control.Bounds;}}
        internal static void Move(Control control,Point point){using(var scope=new Scope()){
            if(!scope.Physical){control.Location=point;return;}
            if(!SetWindowPos(control.Handle,IntPtr.Zero,point.X,point.Y,0,0,0x0001|0x0004|0x0010|0x0200))throw new InvalidOperationException("Tray menu positioning failed");
        }}
    }
    internal sealed class TrayTarget {
        internal string Name,Label,State;
        internal bool CanConnect,CanDisconnect,CanRename,CanSwitch,Ssh;
        // Colour of the state text: 1 connected, 2 SSH, 0 anything else.
        internal int Tone;
    }
    // The tray keeps the look of the Windows 11 menus rather than the app's own page colours.
    internal sealed class TrayLook {
        internal bool Dark;
        internal Color Back,Border,Text,Muted,Off,Hover,Line,Green,Blue;
        internal static TrayLook Create(bool dark){
            return dark
                ?new TrayLook{Dark=true,Back=Color.FromArgb(43,43,43),Border=Color.FromArgb(61,61,61),Text=Color.FromArgb(243,243,243),Muted=Color.FromArgb(154,154,154),Off=Color.FromArgb(111,111,111),Hover=Color.FromArgb(58,58,58),Line=Color.FromArgb(59,59,59),Green=Color.FromArgb(108,203,139),Blue=Color.FromArgb(127,180,255)}
                :new TrayLook{Back=Color.FromArgb(249,249,249),Border=Color.FromArgb(222,222,222),Text=Color.FromArgb(27,27,27),Muted=Color.FromArgb(107,107,107),Off=Color.FromArgb(165,165,165),Hover=Color.FromArgb(235,235,235),Line=Color.FromArgb(227,227,227),Green=Color.FromArgb(31,157,85),Blue=Color.FromArgb(43,111,214)};
        }
        internal Color Tone(int tone){return tone==1?Green:tone==2?Blue:Muted;}
    }
    internal sealed class TrayMenu : IDisposable {
        [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
        // What a row shows: an icon or a state dot, the name, and the state on the right.
        internal sealed class Row {internal string Icon,Name,State;internal int Dot=-1,Tone;}
        internal readonly ContextMenuStrip Menu;
        internal readonly ContextMenuStrip ActivationMenu=new ContextMenuStrip{ShowImageMargin=false};
        readonly Form popupOwner;
        readonly IntPtr uiContext;
        internal readonly Dictionary<string,ToolStripMenuItem> Targets=new Dictionary<string,ToolStripMenuItem>(StringComparer.Ordinal);
        readonly ToolStripMenuItem open=new ToolStripMenuItem{Tag=new Row{Icon="open"}},exit=new ToolStripMenuItem{Tag=new Row{Icon="exit"}},empty=new ToolStripMenuItem{Enabled=false,Tag=new Row()};
        readonly ToolStripSeparator first=new ToolStripSeparator(),last=new ToolStripSeparator();
        readonly Action<string,string> invoke;
        readonly Func<bool> systemTheme;
        readonly Func<Point> pointer;
        readonly Renderer renderer;
        readonly HashSet<ToolStrip> roundedByWindows=new HashSet<ToolStrip>();
        Point? anchor;
        bool positioning;
        bool openingQueued,disposed;
        Point queuedPoint;
        Font font,small;
        internal Palette Colors;
        internal TrayLook Look;
        internal float Scale=1;
        internal int Px(float value){return (int)Math.Round(value*Scale);}
        internal TrayMenu(Action refresh,Action restore,Action quit,Action<string,string> command,Func<bool> theme=null,Func<Point> position=null){
            invoke=command;systemTheme=theme??(()=>AppSettings.SystemDark(true,false));pointer=position??(()=>TrayDisplay.Pointer());
            uiContext=TrayDisplay.Context;renderer=new Renderer(this);
            using(var scope=new TrayDisplay.Scope()){
                popupOwner=new Form{ShowInTaskbar=false,FormBorderStyle=FormBorderStyle.None,StartPosition=FormStartPosition.Manual,Bounds=new Rectangle(0,0,1,1)};
                Menu=new ContextMenuStrip{ShowImageMargin=false};
                IntPtr ownerHandle=popupOwner.Handle,menuHandle=Menu.Handle;
            }
            ActivationMenu.Opening+=delegate(object sender,System.ComponentModel.CancelEventArgs e){
                e.Cancel=true;queuedPoint=pointer();if(openingQueued||disposed)return;openingQueued=true;
                Menu.BeginInvoke(new Action(delegate{openingQueued=false;if(!disposed)ShowAt(queuedPoint);}));
            };
            open.Click+=delegate{using(var scope=new TrayDisplay.Scope(uiContext))restore();};exit.Click+=delegate{using(var scope=new TrayDisplay.Scope(uiContext))quit();};
            Menu.Items.AddRange(new ToolStripItem[]{open,first,empty,last,exit});
            Menu.Opening+=delegate{
                if(!anchor.HasValue)anchor=pointer();using(var scope=new TrayDisplay.Scope(uiContext))refresh();ApplySystemTheme();
                SetScale(TrayDisplay.Scale(anchor.Value));Fit(Menu);
            };
            Prepare(Menu);
            Menu.Opened+=delegate{Reposition();};Menu.SizeChanged+=delegate{if(Menu.Visible)Reposition();};Menu.LocationChanged+=delegate{if(Menu.Visible)Reposition();};Menu.Closed+=delegate{anchor=null;};ApplySystemTheme();
        }
        void Prepare(ToolStripDropDownMenu menu){
            menu.ShowImageMargin=false;menu.ShowCheckMargin=false;menu.Renderer=renderer;
            if(menu!=Menu)menu.Opening+=delegate{Fit(menu);Round(menu);};
            menu.Opened+=delegate{Round(menu);};menu.SizeChanged+=delegate{if(menu.Visible)Round(menu);};
        }
        void SetScale(float value){
            if(value<=0||Math.Abs(value-Scale)<0.01f&&font!=null)return;
            Scale=value;if(font!=null){font.Dispose();small.Dispose();font=small=null;}
        }
        void EnsureFonts(){
            if(font!=null)return;
            font=new Font("Microsoft YaHei UI",14*Scale,GraphicsUnit.Pixel);small=new Font("Microsoft YaHei UI",13*Scale,GraphicsUnit.Pixel);
        }
        // Windows 11 rounds the menu and draws its border and shadow; older systems get a rounded region.
        void Round(ToolStripDropDown menu){
            if(!menu.IsHandleCreated||Look==null)return;
            int corner=2,border=ColorTranslator.ToWin32(Look.Border);bool native=false;
            try{native=DwmSetWindowAttribute(menu.Handle,33,ref corner,4)==0;if(native)DwmSetWindowAttribute(menu.Handle,34,ref border,4);}
            catch(DllNotFoundException){}catch(EntryPointNotFoundException){}
            if(native){roundedByWindows.Add(menu);if(menu.Region!=null)menu.Region=null;return;}
            roundedByWindows.Remove(menu);
            using(var path=PaintUi.Round(new Rectangle(0,0,menu.Width,menu.Height),Px(8)))menu.Region=new Region(path);
        }
        internal bool RoundedByWindows(ToolStrip strip){return roundedByWindows.Contains(strip);}
        // Rows are 36 px high and every row shares the width of the widest one.
        void Fit(ToolStripDropDownMenu menu){
            EnsureFonts();
            int width=Px(menu==Menu?248:200);
            foreach(ToolStripItem item in menu.Items){
                var row=item.Tag as Row;if(row==null)continue;
                int need=Px(42+16)+TextRenderer.MeasureText(row.Name??"",font).Width;
                if(!String.IsNullOrEmpty(row.State))need+=Px(16)+TextRenderer.MeasureText(row.State,small).Width;
                var menuItem=item as ToolStripMenuItem;if(menuItem!=null&&menuItem.HasDropDownItems)need+=Px(18);
                width=Math.Max(width,need);
            }
            menu.SuspendLayout();
            menu.Padding=new Padding(0,Px(4),0,Px(4));
            foreach(ToolStripItem item in menu.Items){item.AutoSize=false;item.Margin=Padding.Empty;item.Padding=Padding.Empty;item.Font=font;item.Size=new Size(width,item is ToolStripSeparator?Px(9):Px(36));}
            // The drop-down sizes itself from the item text, not the item size, so its width is set directly.
            menu.MinimumSize=new Size(width+menu.Padding.Horizontal,0);
            menu.ResumeLayout(true);
        }
        internal void ShowAt(Point screenPoint){
            if(Menu.Visible)Menu.Close();
            anchor=screenPoint;
            try{
                using(var scope=new TrayDisplay.Scope())Menu.Show(popupOwner,popupOwner.PointToClient(screenPoint),ToolStripDropDownDirection.AboveLeft);
                Reposition();
            }catch{anchor=null;throw;}
        }
        internal static Point Position(Point point,Size size,Rectangle area){
            int x=Math.Max(area.Left,Math.Min(point.X-size.Width,area.Right-size.Width));
            int y=Math.Max(area.Top,Math.Min(point.Y-size.Height,area.Bottom-size.Height));
            return new Point(x,y);
        }
        void Reposition(){
            if(!anchor.HasValue||positioning||Menu.IsDisposed)return;
            positioning=true;
            try{Point point=anchor.Value;Rectangle bounds=TrayDisplay.Bounds(Menu);Point target=Position(point,bounds.Size,TrayDisplay.WorkingArea(point));if(bounds.Location!=target)TrayDisplay.Move(Menu,target);}
            finally{positioning=false;}
        }
        ToolStripMenuItem Create(string id){
            using(var scope=new TrayDisplay.Scope()){
                var sub=new ToolStripDropDownMenu();Prepare(sub);
                var item=new ToolStripMenuItem{Name=id,DropDown=sub,Tag=new Row()};
                foreach(string action in new[]{"connect","stop","rename"}){
                    string selected=action;var child=new ToolStripMenuItem{Name=action,Tag=new Row{Icon=action}};child.Click+=delegate{using(var context=new TrayDisplay.Scope(uiContext))invoke(id,selected);};item.DropDownItems.Add(child);
                }
                // Switches between the shared web page and SSH, like the switch on the card.
                var change=new ToolStripMenuItem{Name="switch",Tag=new Row{Icon="ssh"}};change.Click+=delegate{using(var context=new TrayDisplay.Scope(uiContext))invoke(id,"switch");};
                item.DropDownItems.Add(new ToolStripSeparator());item.DropDownItems.Add(change);
                return item;
            }
        }
        static void Label(ToolStripItem item,string text){item.Text=text;((Row)item.Tag).Name=text;}
        internal void Sync(IList<TrayTarget> values){
            Label(open,L.Text("打开主界面"));Label(exit,L.Text("退出程序"));Label(empty,L.Text("暂无设备"));
            foreach(string id in Targets.Keys.Where(id=>!values.Any(v=>v.Name==id)).ToArray()){var item=Targets[id];Menu.Items.Remove(item);Targets.Remove(id);item.Dispose();}
            if(values.Count==0){if(!Menu.Items.Contains(empty))Menu.Items.Insert(2,empty);}
            else Menu.Items.Remove(empty);
            for(int i=0;i<values.Count;i++){
                var value=values[i];ToolStripMenuItem item;
                if(!Targets.TryGetValue(value.Name,out item)){item=Create(value.Name);Targets.Add(value.Name,item);}
                int position=i+2;if(Menu.Items.IndexOf(item)!=position){Menu.Items.Remove(item);Menu.Items.Insert(position,item);}
                string state=L.Text(value.State),text=value.Label+" · "+state;item.Text=text.Replace("&","&&");item.ToolTipText=text;
                var row=(Row)item.Tag;row.Name=value.Label;row.State=state;row.Dot=row.Tone=value.Tone;
                var connect=(ToolStripMenuItem)item.DropDownItems[0];Label(connect,L.Text("连接设备"));connect.Enabled=value.CanConnect;
                var stop=(ToolStripMenuItem)item.DropDownItems[1];Label(stop,L.Text("断开设备"));stop.Enabled=value.CanDisconnect;
                var rename=(ToolStripMenuItem)item.DropDownItems[2];Label(rename,L.Text("重命名"));rename.Enabled=value.CanRename;
                var change=(ToolStripMenuItem)item.DropDownItems[4];Label(change,L.Text(value.Ssh?"切换为网页登录":"切换为 SSH 登录"));((Row)change.Tag).Icon=value.Ssh?"web":"ssh";change.Enabled=value.CanSwitch;
            }
            ApplySystemTheme();
            if(Menu.Visible){Fit(Menu);foreach(var item in Targets.Values)if(item.DropDown.Visible)Fit((ToolStripDropDownMenu)item.DropDown);}
        }
        internal void ApplySystemTheme(){
            bool dark=systemTheme();if(Colors==null||Colors.Dark!=dark){Colors=Palette.Create(dark);Look=TrayLook.Create(dark);}
            Paint(Menu);
        }
        void Paint(ToolStrip menu){menu.BackColor=Look.Back;menu.ForeColor=Look.Text;menu.Renderer=renderer;foreach(var item in menu.Items.OfType<ToolStripMenuItem>())if(item.HasDropDownItems)Paint(item.DropDown);if(menu.Visible)Round((ToolStripDropDown)menu);menu.Invalidate();}
        static readonly StringFormat nameFormat=new StringFormat(StringFormatFlags.NoWrap){LineAlignment=StringAlignment.Center,Trimming=StringTrimming.EllipsisCharacter,HotkeyPrefix=System.Drawing.Text.HotkeyPrefix.None};
        static readonly StringFormat stateFormat=new StringFormat(StringFormatFlags.NoWrap){Alignment=StringAlignment.Far,LineAlignment=StringAlignment.Center,Trimming=StringTrimming.None,HotkeyPrefix=System.Drawing.Text.HotkeyPrefix.None};
        // Text is drawn smoothed (grayscale), the way the reference menu renders it, at 14 px.
        internal void DrawRow(Graphics g,ToolStripItem item){
            var row=item.Tag as Row;if(row==null)return;EnsureFonts();
            int h=item.Height;float lead=16*Scale;Color text=item.Enabled?Look.Text:Look.Off;
            var box=new RectangleF(Px(16),(h-lead)/2f,lead,lead);
            g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            if(row.Icon!=null)TrayIcons.Draw(g,row.Icon,box,text,Scale);
            else if(row.Dot>=0){float d=7*Scale;using(var brush=new SolidBrush(row.Dot==1?Look.Green:row.Dot==2?Look.Blue:Look.Off))g.FillEllipse(brush,box.X+(lead-d)/2,box.Y+(lead-d)/2,d,d);}
            float left=Px(42),right=item.Width-Px(16);var menuItem=item as ToolStripMenuItem;if(menuItem!=null&&menuItem.HasDropDownItems)right-=Px(18);
            g.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            if(!String.IsNullOrEmpty(row.State)){
                float width=g.MeasureString(row.State,small,PointF.Empty,StringFormat.GenericTypographic).Width;
                using(var brush=new SolidBrush(item.Enabled?Look.Tone(row.Tone):Look.Off))g.DrawString(row.State,small,brush,new RectangleF(left,0,Math.Max(1,right-left),h),stateFormat);
                right-=width+Px(14);
            }
            using(var brush=new SolidBrush(text))g.DrawString(row.Name??"",font,brush,new RectangleF(left,0,Math.Max(1,right-left),h),nameFormat);
        }
        internal void DrawChevron(Graphics g,ToolStripItem item){
            float s=Scale,x=item.Width-Px(16)-12*s,y=item.Height/2f-6*s;
            g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using(var pen=new Pen(Color.FromArgb(217,item.Enabled?Look.Text:Look.Off),1.4f*s){StartCap=System.Drawing.Drawing2D.LineCap.Round,EndCap=System.Drawing.Drawing2D.LineCap.Round,LineJoin=System.Drawing.Drawing2D.LineJoin.Round})
                g.DrawLines(pen,new[]{new PointF(x+4.2f*s,y+2.2f*s),new PointF(x+8f*s,y+6f*s),new PointF(x+4.2f*s,y+9.8f*s)});
        }
        sealed class Renderer : ToolStripRenderer {
            readonly TrayMenu owner;internal Renderer(TrayMenu value){owner=value;}
            protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e){using(var brush=new SolidBrush(owner.Look.Back))e.Graphics.FillRectangle(brush,e.AffectedBounds);}
            protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e){
                if(owner.RoundedByWindows(e.ToolStrip))return;
                e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using(var path=PaintUi.Round(new Rectangle(0,0,e.ToolStrip.Width-1,e.ToolStrip.Height-1),owner.Px(8)))using(var pen=new Pen(owner.Look.Border))e.Graphics.DrawPath(pen,path);
            }
            protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e){
                if(!e.Item.Selected||!e.Item.Enabled)return;
                e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;int inset=owner.Px(4);
                using(var path=PaintUi.Round(new Rectangle(inset,0,e.Item.Width-inset*2,e.Item.Height),owner.Px(5)))using(var brush=new SolidBrush(owner.Look.Hover))e.Graphics.FillPath(brush,path);
            }
            protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e){int y=e.Item.Height/2;using(var pen=new Pen(owner.Look.Line))e.Graphics.DrawLine(pen,0,y,e.Item.Width,y);}
            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e){owner.DrawRow(e.Graphics,e.Item);}
            protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e){owner.DrawChevron(e.Graphics,e.Item);}
        }
        public void Dispose(){disposed=true;ActivationMenu.Dispose();Menu.Dispose();popupOwner.Dispose();empty.Dispose();if(font!=null){font.Dispose();small.Dispose();}}
    }
    // Line icons on a 16 px grid, drawn at the menu's scale.
    internal static class TrayIcons {
        internal static void Draw(Graphics g,string name,RectangleF box,Color color,float scale){
            float u=box.Width/16f;Func<float,float,PointF> p=(x,y)=>new PointF(box.X+x*u,box.Y+y*u);
            using(var pen=new Pen(color,1.25f*scale){StartCap=System.Drawing.Drawing2D.LineCap.Round,EndCap=System.Drawing.Drawing2D.LineCap.Round,LineJoin=System.Drawing.Drawing2D.LineJoin.Round}){
                switch(name){
                    case "open":Box(g,pen,box,u,2.2f,3f,11.6f,10f,1.8f);g.DrawLine(pen,p(2.6f,5.8f),p(13.4f,5.8f));break;
                    case "exit":g.DrawLine(pen,p(8,2.2f),p(8,7.6f));g.DrawArc(pen,box.X+3.2f*u,box.Y+4.2f*u,9.6f*u,9.6f*u,-50,280);break;
                    case "connect":g.DrawPolygon(pen,new[]{p(5.5f,3.5f),p(5.5f,12.5f),p(12.5f,8)});break;
                    case "stop":Box(g,pen,box,u,4,4,8,8,1.5f);break;
                    case "rename":g.DrawPolygon(pen,new[]{p(3,13),p(6,13),p(13,6),p(10,3),p(3,10)});break;
                    case "web":g.DrawEllipse(pen,box.X+2.4f*u,box.Y+2.4f*u,11.2f*u,11.2f*u);g.DrawLine(pen,p(2.6f,8),p(13.4f,8));g.DrawEllipse(pen,box.X+5.6f*u,box.Y+2.4f*u,4.8f*u,11.2f*u);break;
                    case "ssh":Box(g,pen,box,u,2,3,12,10,1.8f);g.DrawLines(pen,new[]{p(4.8f,6.4f),p(6.8f,8),p(4.8f,9.6f)});g.DrawLine(pen,p(8.4f,10),p(11.2f,10));break;
                }
            }
        }
        static void Box(Graphics g,Pen pen,RectangleF box,float u,float x,float y,float w,float h,float r){
            using(var path=new System.Drawing.Drawing2D.GraphicsPath()){
                float d=2*r*u;var rect=new RectangleF(box.X+x*u,box.Y+y*u,w*u,h*u);
                path.AddArc(rect.X,rect.Y,d,d,180,90);path.AddArc(rect.Right-d,rect.Y,d,d,270,90);path.AddArc(rect.Right-d,rect.Bottom-d,d,d,0,90);path.AddArc(rect.X,rect.Bottom-d,d,d,90,90);path.CloseFigure();
                g.DrawPath(pen,path);
            }
        }
    }
}
