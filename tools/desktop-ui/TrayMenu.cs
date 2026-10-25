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
        internal static Rectangle Bounds(Control control){using(var scope=new Scope()){NativeRect rect;if(scope.Physical&&GetWindowRect(control.Handle,out rect))return rect.Rectangle;return control.Bounds;}}
        internal static void Move(Control control,Point point){using(var scope=new Scope()){
            if(!scope.Physical){control.Location=point;return;}
            if(!SetWindowPos(control.Handle,IntPtr.Zero,point.X,point.Y,0,0,0x0001|0x0004|0x0010|0x0200))throw new InvalidOperationException("Tray menu positioning failed");
        }}
    }
    internal sealed class TrayTarget {
        internal string Name,Label,State;
        internal bool CanConnect,CanDisconnect,CanRename;
    }
    internal sealed class TrayMenu : IDisposable {
        internal readonly ContextMenuStrip Menu;
        internal readonly ContextMenuStrip ActivationMenu=new ContextMenuStrip{ShowImageMargin=false};
        readonly Form popupOwner;
        readonly IntPtr uiContext;
        internal readonly Dictionary<string,ToolStripMenuItem> Targets=new Dictionary<string,ToolStripMenuItem>(StringComparer.Ordinal);
        readonly ToolStripMenuItem open=new ToolStripMenuItem(),exit=new ToolStripMenuItem(),empty=new ToolStripMenuItem{Enabled=false};
        readonly ToolStripSeparator first=new ToolStripSeparator(),last=new ToolStripSeparator();
        readonly Action<string,string> invoke;
        readonly Func<bool> systemTheme;
        readonly Func<Point> pointer;
        Point? anchor;
        bool positioning;
        bool openingQueued,disposed;
        Point queuedPoint;
        internal Palette Colors;
        internal TrayMenu(Action refresh,Action restore,Action quit,Action<string,string> command,Func<bool> theme=null,Func<Point> position=null){
            invoke=command;systemTheme=theme??(()=>AppSettings.SystemDark(true,false));pointer=position??(()=>TrayDisplay.Pointer());
            uiContext=TrayDisplay.Context;
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
            Menu.Opening+=delegate{if(!anchor.HasValue)anchor=pointer();using(var scope=new TrayDisplay.Scope(uiContext))refresh();ApplySystemTheme();};
            Menu.Opened+=delegate{Reposition();};Menu.SizeChanged+=delegate{if(Menu.Visible)Reposition();};Menu.LocationChanged+=delegate{if(Menu.Visible)Reposition();};Menu.Closed+=delegate{anchor=null;};ApplySystemTheme();
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
                var item=new ToolStripMenuItem{Name=id,DropDown=new ToolStripDropDownMenu{ShowImageMargin=false}};
                foreach(string action in new[]{"connect","stop","rename"}){
                    string selected=action;var child=new ToolStripMenuItem{Name=action};child.Click+=delegate{using(var context=new TrayDisplay.Scope(uiContext))invoke(id,selected);};item.DropDownItems.Add(child);
                }
                return item;
            }
        }
        internal void Sync(IList<TrayTarget> values){
            open.Text=L.Text("打开主界面");exit.Text=L.Text("退出程序");empty.Text=L.Text("暂无云电脑");
            foreach(string id in Targets.Keys.Where(id=>!values.Any(v=>v.Name==id)).ToArray()){var item=Targets[id];Menu.Items.Remove(item);Targets.Remove(id);item.Dispose();}
            if(values.Count==0){if(!Menu.Items.Contains(empty))Menu.Items.Insert(2,empty);}
            else Menu.Items.Remove(empty);
            for(int i=0;i<values.Count;i++){
                var value=values[i];ToolStripMenuItem item;
                if(!Targets.TryGetValue(value.Name,out item)){item=Create(value.Name);Targets.Add(value.Name,item);}
                int position=i+2;if(Menu.Items.IndexOf(item)!=position){Menu.Items.Remove(item);Menu.Items.Insert(position,item);}
                string text=value.Label+" · "+L.Text(value.State);item.Text=text.Replace("&","&&");item.ToolTipText=text;
                var connect=(ToolStripMenuItem)item.DropDownItems[0];connect.Text=L.Text("连接云电脑");connect.Enabled=value.CanConnect;
                var stop=(ToolStripMenuItem)item.DropDownItems[1];stop.Text=L.Text("断开云电脑");stop.Enabled=value.CanDisconnect;
                var rename=(ToolStripMenuItem)item.DropDownItems[2];rename.Text=L.Text("重命名");rename.Enabled=value.CanRename;
            }
            ApplySystemTheme();
        }
        internal void ApplySystemTheme(){
            bool dark=systemTheme();if(Colors==null||Colors.Dark!=dark){Colors=Palette.Create(dark);Menu.Renderer=new Renderer(Colors);}
            Paint(Menu);
        }
        void Paint(ToolStrip menu){menu.BackColor=Colors.Surface;menu.ForeColor=Colors.Text;menu.Renderer=Menu.Renderer;foreach(var item in menu.Items.OfType<ToolStripMenuItem>())if(item.HasDropDownItems)Paint(item.DropDown);menu.Invalidate();}
        sealed class Table : ProfessionalColorTable {
            readonly Palette colors;internal Table(Palette value){colors=value;UseSystemColors=false;}
            public override Color ToolStripDropDownBackground{get{return colors.Surface;}}
            public override Color ImageMarginGradientBegin{get{return colors.Surface;}}
            public override Color ImageMarginGradientMiddle{get{return colors.Surface;}}
            public override Color ImageMarginGradientEnd{get{return colors.Surface;}}
            public override Color MenuBorder{get{return colors.Border;}}
            public override Color MenuItemBorder{get{return colors.Subtle;}}
            public override Color MenuItemSelected{get{return colors.Subtle;}}
            public override Color MenuItemSelectedGradientBegin{get{return colors.Subtle;}}
            public override Color MenuItemSelectedGradientEnd{get{return colors.Subtle;}}
            public override Color MenuItemPressedGradientBegin{get{return colors.Subtle;}}
            public override Color MenuItemPressedGradientMiddle{get{return colors.Subtle;}}
            public override Color MenuItemPressedGradientEnd{get{return colors.Subtle;}}
            public override Color SeparatorDark{get{return colors.Border;}}
            public override Color SeparatorLight{get{return colors.Border;}}
        }
        sealed class Renderer : ToolStripProfessionalRenderer {
            readonly Palette colors;internal Renderer(Palette value):base(new Table(value)){colors=value;RoundedEdges=false;}
            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e){e.TextColor=e.Item.Enabled?colors.Text:colors.Muted;base.OnRenderItemText(e);}
            protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e){e.ArrowColor=e.Item.Enabled?colors.Text:colors.Muted;base.OnRenderArrow(e);}
        }
        public void Dispose(){disposed=true;ActivationMenu.Dispose();Menu.Dispose();popupOwner.Dispose();empty.Dispose();}
    }
}
