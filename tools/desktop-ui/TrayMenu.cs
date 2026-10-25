using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class TrayTarget {
        internal string Name,Label,State;
        internal bool CanConnect,CanDisconnect,CanRename;
    }
    internal sealed class TrayMenu : IDisposable {
        internal readonly ContextMenuStrip Menu=new ContextMenuStrip{ShowImageMargin=false};
        internal readonly Dictionary<string,ToolStripMenuItem> Targets=new Dictionary<string,ToolStripMenuItem>(StringComparer.Ordinal);
        readonly ToolStripMenuItem open=new ToolStripMenuItem(),exit=new ToolStripMenuItem(),empty=new ToolStripMenuItem{Enabled=false};
        readonly ToolStripSeparator first=new ToolStripSeparator(),last=new ToolStripSeparator();
        readonly Action<string,string> invoke;
        readonly Func<bool> systemTheme;
        internal Palette Colors;
        internal TrayMenu(Action refresh,Action restore,Action quit,Action<string,string> command,Func<bool> theme=null){
            invoke=command;systemTheme=theme??(()=>AppSettings.SystemDark(true,false));
            open.Click+=delegate{restore();};exit.Click+=delegate{quit();};
            Menu.Items.AddRange(new ToolStripItem[]{open,first,empty,last,exit});
            Menu.Opening+=delegate{refresh();ApplySystemTheme();};ApplySystemTheme();
        }
        ToolStripMenuItem Create(string id){
            var item=new ToolStripMenuItem{Name=id};
            foreach(string action in new[]{"connect","stop","rename"}){
                string selected=action;var child=new ToolStripMenuItem{Name=action};child.Click+=delegate{invoke(id,selected);};item.DropDownItems.Add(child);
            }
            return item;
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
        public void Dispose(){Menu.Dispose();empty.Dispose();}
    }
}
