using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    // Categories on the left, grouped rows in a centered column on the right. All row
    // controls stay direct children of one sheet, so wheel and keyboard handling are shared.
    internal sealed class SettingsPage : UserControl {
        sealed class Row { internal Label Title,Description; internal Control Control; }
        sealed class Section { internal Label Heading; internal Control Leading; internal readonly List<Row> Rows=new List<Row>(); }
        const int ColumnWidth=680,RowHeight=56,RowPadding=16,OptionWidth=122;
        internal readonly EditorViewport Viewport=new EditorViewport{Dock=DockStyle.Fill,AutoScroll=true};
        internal readonly ModernButton Back=new ModernButton{Glyph="back",Text="返回",Nav=true,AccessibleName="返回"};
        internal readonly ModernButton GeneralTab=new ModernButton{Glyph="sliders",Text="通用",Nav=true},AboutTab=new ModernButton{Glyph="info",Text="关于",Nav=true};
        readonly ResizePanel side=new ResizePanel{Dock=DockStyle.Left,Width=176},top=new ResizePanel{Dock=DockStyle.Top,Height=56};
        readonly Label group=new Label(),version=new Label(),title=new Label{TextAlign=ContentAlignment.MiddleLeft};
        readonly Label feedback=new Label{AutoSize=false};
        readonly SettingsSheet sheet=new SettingsSheet();
        readonly AppSettings settings;
        readonly Action<AppSettings> change;
        readonly Action<string> action;
        readonly List<Action> refresh=new List<Action>();
        readonly List<Section> sections=new List<Section>();
        readonly string currentVersion=System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
        Palette colors;
        bool isAbout,laying,updateAvailable;
        string availableVersion;
        internal string UpdateStatus="检查更新";
        readonly UpdateProgressView updateView=new UpdateProgressView();
        UpdateProgress updateProgress;
        internal Action<Control,int,Action> AnimateContent;
        internal void ShowAbout(){isAbout=true;Build();}
        void ShowTab(bool toAbout){
            if(isAbout==toAbout)return;
            Action swap=delegate{isAbout=toAbout;Build();};
            if(AnimateContent!=null)AnimateContent(Viewport,toAbout?1:-1,swap);else swap();
        }
        internal event Action BackRequested;
        internal SettingsPage(AppSettings values,Palette palette,Action<AppSettings> changed,Action<string> invoked){
            Dock=DockStyle.Fill;Font=UiFont.Points(11F);settings=values;colors=palette;change=changed;action=invoked;
            side.Font=UiFont.Points(10.5F);sheet.Font=UiFont.Points(10.5F);group.Font=UiFont.Points(9F);version.Font=UiFont.Points(9F);
            title.Font=new Font(UiFont.Points(13F),FontStyle.Bold);
            version.Text="CMCP v"+currentVersion;
            side.Controls.AddRange(new Control[]{Back,group,GeneralTab,AboutTab,version});top.Controls.Add(title);Viewport.Controls.Add(sheet);
            Controls.Add(Viewport);Controls.Add(top);Controls.Add(side);
            title.Bounds=new Rectangle(58,0,420,55);
            top.Paint+=delegate(object sender,PaintEventArgs e){
                e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                PaintUi.Icon(e.Graphics,isAbout?"info":"sliders",new Rectangle(28,17,22,22),colors.Text);
                using(var p=new Pen(colors.Border))e.Graphics.DrawLine(p,0,top.Height-1,top.Width,top.Height-1);
            };
            side.Paint+=delegate(object sender,PaintEventArgs e){using(var p=new Pen(colors.Border))e.Graphics.DrawLine(p,side.Width-1,0,side.Width-1,side.Height);};
            Back.Click+=delegate{if(BackRequested!=null)BackRequested();};GeneralTab.Click+=delegate{ShowTab(false);};AboutTab.Click+=delegate{ShowTab(true);};
            side.SizeChanged+=delegate{LayoutSide();};
            Viewport.SizeChanged+=delegate{PlaceSheet();};
            SizeChanged+=delegate{side.Width=Width<800?150:176;};
            sheet.SizeChanged+=delegate{LayoutRows();};
            LayoutSide();Build();
        }
        void LayoutSide(){
            int width=side.Width-20;
            Back.Bounds=new Rectangle(10,14,width,36);group.Bounds=new Rectangle(20,60,width-20,20);
            GeneralTab.Bounds=new Rectangle(10,84,width,38);AboutTab.Bounds=new Rectangle(10,124,width,38);
            version.Bounds=new Rectangle(20,Math.Max(170,side.Height-38),width-20,22);
            side.Invalidate();
        }
        void PlaceSheet(){
            int client=Viewport.ClientSize.Width,pad=client<560?18:28,width=Math.Max(200,Math.Min(ColumnWidth,client-2*pad));
            sheet.SetBounds((client-width)/2,20+Viewport.AutoScrollPosition.Y,width,sheet.Height);
        }
        Section AddSection(string text){
            var section=new Section{Heading=new Label{Font=new Font(sheet.Font,FontStyle.Bold),TextAlign=ContentAlignment.MiddleLeft}};
            sheet.Controls.Add(section.Heading);refresh.Add(delegate{section.Heading.Text=L.Text(text);});sections.Add(section);return section;
        }
        void AddRow(Section section,Func<string> name,Func<string> detail,Control control){
            var row=new Row{Title=new Label{Font=sheet.Font},Control=control};
            sheet.Controls.Add(row.Title);refresh.Add(delegate{row.Title.Text=name();});
            if(detail!=null){row.Description=new Label{Font=UiFont.Points(9F)};sheet.Controls.Add(row.Description);refresh.Add(delegate{row.Description.Text=detail();});}
            if(control!=null)sheet.Controls.Add(control);
            section.Rows.Add(row);
        }
        void AddRow(Section section,string name,string detail,Control control){
            AddRow(section,()=>L.Text(name),detail==null?(Func<string>)null:(()=>L.Text(detail)),control);
        }
        ModernButton Command(string text,Action click,bool primary=false){
            var b=new ModernButton{Text=text,CenterText=true,Primary=primary,Neutral=!primary,Font=sheet.Font};b.Click+=delegate{click();};return b;
        }
        ModernButton Danger(string text,Action click){
            var b=new ModernButton{Text=text,CenterText=true,Destructive=true,Font=sheet.Font};b.Click+=delegate{click();};return b;
        }
        ToggleSwitch Switch(string text,Func<bool> value,Action<AppSettings,bool> edit){
            var toggle=new ToggleSwitch{Text=L.Text(text),Checked=value(),Colors=colors,Size=new Size(48,30)};
            toggle.Click+=delegate{Commit(s=>edit(s,toggle.Checked));};
            refresh.Add(delegate{toggle.Checked=value();toggle.Text=L.Text(text);});return toggle;
        }
        RoundedSheet Group(int count){return new RoundedSheet{Size=new Size(count*OptionWidth+10,40)};}
        void Option(RoundedSheet track,int index,string glyph,string text,Action<AppSettings> edit,Func<bool> chosen){
            var b=new ModernButton{Glyph=glyph,Text=text,Segment=true,Font=sheet.Font,Bounds=new Rectangle(5+index*OptionWidth,4,OptionWidth,32)};
            b.Click+=delegate{if(!chosen())Commit(edit);};
            track.Controls.Add(b);refresh.Add(delegate{b.Selected=chosen();b.Invalidate();});
        }
        void RefreshControls(){
            title.Text=L.Text(isAbout?"关于":"通用");group.Text=L.Text("设置");
            foreach(var update in refresh)update();
            Apply(colors);LayoutRows();top.Invalidate();
        }
        void Commit(Action<AppSettings> edit){var next=settings.Copy();edit(next);try{change(next);settings.language=next.language;settings.theme=next.theme;settings.autoStart=next.autoStart;settings.closeToTray=next.closeToTray;}catch{RefreshControls();SetFeedback("设置未能保存，请检查本机文件和注册表权限。",true);return;}RefreshControls();SetFeedback("设置已保存。",false);}
        void Build(){
            refresh.Clear();sections.Clear();
            sheet.Controls.Remove(feedback);sheet.Controls.Remove(updateView);foreach(Control c in sheet.Controls.Cast<Control>().ToArray())c.Dispose();sheet.Controls.Clear();
            GeneralTab.Selected=!isAbout;AboutTab.Selected=isAbout;feedback.Text="";
            if(isAbout)BuildAbout();else BuildGeneral();
            sheet.Controls.Add(feedback);
            Viewport.AutoScrollPosition=Point.Empty;PlaceSheet();RefreshControls();
        }
        void BuildGeneral(){
            var appearance=AddSection("外观");
            var language=new DropdownField(new[]{new KeyValuePair<string,string>("zh-CN","简体中文"),new KeyValuePair<string,string>("en","English")}){Font=sheet.Font,Size=new Size(150,36),Colors=colors};
            language.Chosen+=key=>Commit(s=>s.language=key);refresh.Add(delegate{language.Value=settings.language;language.AccessibleName=L.Text("界面语言");language.Invalidate();});
            AddRow(appearance,"界面语言",null,language);
            var theme=Group(3);
            Option(theme,0,"monitor","跟随系统",s=>s.theme="system",()=>settings.theme=="system");
            Option(theme,1,"sun","浅色",s=>s.theme="light",()=>settings.theme=="light");
            Option(theme,2,"moon","深色",s=>s.theme="dark",()=>settings.theme=="dark");
            AddRow(appearance,"主题",null,theme);
            var window=AddSection("窗口");
            AddRow(window,"开机自启","登录 Windows 后启动到系统托盘；只恢复原来已启用的连接。",Switch("开机自启",()=>settings.autoStart,(s,on)=>s.autoStart=on));
            AddRow(window,"关闭时最小化到托盘","开启时保留已连接的云电脑；关闭后，点叉号会退出并断开全部连接。",Switch("关闭时最小化到托盘",()=>settings.closeToTray,(s,on)=>s.closeToTray=on));
            var shortcuts=AddSection("快捷方式");
            AddRow(shortcuts,"桌面快捷方式","为当前程序创建 CMCP 桌面快捷方式。",Command("创建",delegate{action("shortcut");}));
        }
        void BuildAbout(){
            var updates=AddSection("更新");
            sheet.Controls.Add(updateView);updateView.Set(updateProgress);updates.Leading=updateView;
            var run=Command("检查更新",delegate{action(updateAvailable?"update":"check");},true);
            refresh.Add(delegate{run.Text=updateAvailable?"立即更新":"检查更新";run.Enabled=updateProgress==null||!updateProgress.Visible||updateProgress.Stage=="failed";run.Invalidate();});
            AddRow(updates,()=>updateAvailable?L.Text("发现新版本")+" "+availableVersion:"CMCP "+currentVersion,
                ()=>updateAvailable?L.Text("当前版本")+" "+currentVersion+"  ·  "+L.Text("更新时会短暂断开连接。"):"Windows x64"+(UpdateStatus=="检查更新"?"":"  ·  "+L.Text(UpdateStatus)),run);
            AddRow(updates,"发布页","查看每个版本的更新内容。",Command("打开",delegate{action("releases");}));
            var folders=AddSection("本机文件夹");
            AddRow(folders,"程序文件夹",null,Command("打开",delegate{action("program");}));
            AddRow(folders,"日志文件夹",null,Command("打开",delegate{action("logs");}));
            var removal=AddSection("卸载");
            AddRow(removal,"卸载 CMCP",Installation.Uninstaller(AppDomain.CurrentDomain.BaseDirectory)!=null?"断开全部连接，移除云电脑上的 Claude 配置，并删除本机保存的地址、密码、设置和程序文件。":"断开全部连接，移除云电脑上的 Claude 配置，并删除本机保存的地址、密码和设置。程序文件夹和桌面快捷方式需要之后手动删除。",Danger("卸载",delegate{action("uninstall");}));
        }
        void LayoutRows(){
            if(laying)return;
            laying=true;
            try{
                int width=sheet.ClientSize.Width,y=0;
                sheet.Cards.Clear();sheet.Dividers.Clear();
                foreach(var section in sections){
                    section.Heading.Bounds=new Rectangle(0,y,width,24);y+=32;
                    if(section.Leading!=null){
                        bool shown=section.Leading.Visible;
                        section.Leading.Bounds=new Rectangle(0,y,width,shown?128:0);if(shown)y+=132;
                    }
                    int cardTop=y;bool first=true;
                    foreach(var row in section.Rows){
                        var button=row.Control as ModernButton;
                        if(button!=null)button.Size=new Size(Math.Max(64,TextRenderer.MeasureText(L.Text(button.Text),button.Font).Width+28),34);
                        int controlWidth=row.Control==null?0:row.Control.Width+20,textWidth=Math.Max(60,width-2*RowPadding-controlWidth);
                        const TextFormatFlags wrap=TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix;
                        int titleHeight=TextRenderer.MeasureText(row.Title.Text,row.Title.Font,new Size(textWidth,0),wrap).Height;
                        int detailHeight=row.Description==null?0:TextRenderer.MeasureText(row.Description.Text,row.Description.Font,new Size(textWidth,0),wrap).Height+2;
                        int height=Math.Max(RowHeight,titleHeight+detailHeight+20),textTop=y+(height-titleHeight-detailHeight)/2;
                        if(!first)sheet.Dividers.Add(y);
                        row.Title.Bounds=new Rectangle(RowPadding,textTop,textWidth,titleHeight);
                        if(row.Description!=null)row.Description.Bounds=new Rectangle(RowPadding,textTop+titleHeight+2,textWidth,detailHeight-2);
                        if(row.Control!=null)row.Control.Location=new Point(width-RowPadding-row.Control.Width,y+(height-row.Control.Height)/2);
                        y+=height;first=false;
                    }
                    sheet.Cards.Add(new Rectangle(0,cardTop,Math.Max(1,width-1),y-cardTop));
                    y+=22;
                }
                feedback.Bounds=new Rectangle(0,y,width,44);y+=44;
                if(sheet.Height!=y)sheet.Height=y;
                Viewport.AutoScrollMinSize=new Size(0,y+44);
                sheet.Invalidate();
            }finally{laying=false;}
        }
        internal void SetFeedback(string message,bool error){feedback.Text=L.Message(message);feedback.ForeColor=error?colors.Danger:colors.Success;if(error)Viewport.ScrollControlIntoView(feedback);}
        internal void SetUpdateAvailable(bool available,string newVersion){if(updateAvailable==available&&availableVersion==newVersion)return;updateAvailable=available;availableVersion=newVersion;AboutTab.Dot=available;AboutTab.Invalidate();RefreshControls();}
        internal void SetUpdateStatus(string value){UpdateStatus=value;RefreshControls();}
        internal void SetUpdateProgress(UpdateProgress value){updateProgress=value;updateView.Set(value);updateView.Apply(colors);RefreshControls();}
        internal void Apply(Palette palette){
            colors=palette;BackColor=top.BackColor=Viewport.BackColor=sheet.BackColor=colors.Page;sheet.Colors=colors;title.ForeColor=colors.Text;title.BackColor=colors.Page;
            side.BackColor=group.BackColor=version.BackColor=colors.Side;group.ForeColor=version.ForeColor=colors.Muted;
            foreach(var b in new[]{Back,GeneralTab,AboutTab}){b.Colors=colors;b.BackColor=colors.Side;b.Invalidate();}
            feedback.BackColor=colors.Page;
            foreach(var section in sections){
                section.Heading.BackColor=colors.Page;section.Heading.ForeColor=colors.Text;
                foreach(var row in section.Rows){
                    row.Title.BackColor=colors.Surface;row.Title.ForeColor=colors.Text;
                    if(row.Description!=null){row.Description.BackColor=colors.Surface;row.Description.ForeColor=colors.Muted;}
                    ApplyControl(row.Control);
                }
            }
            Invalidate(true);updateView.Apply(colors);
        }
        void ApplyControl(Control control){
            var b=control as ModernButton;var track=control as RoundedSheet;var toggle=control as ToggleSwitch;var field=control as DropdownField;
            if(b!=null){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}
            if(track!=null){track.Colors=colors;track.BackColor=colors.Surface;foreach(var option in track.Controls.OfType<ModernButton>()){option.Colors=colors;option.BackColor=colors.Surface;option.Invalidate();}}
            if(toggle!=null){toggle.Colors=colors;toggle.BackColor=colors.Surface;toggle.Invalidate();}
            if(field!=null){field.Colors=colors;field.BackColor=colors.Surface;field.Invalidate();}
        }
        protected override bool ProcessCmdKey(ref Message m,Keys keys){if(keys==Keys.Escape){if(BackRequested!=null)BackRequested();return true;}return base.ProcessCmdKey(ref m,keys);}
        protected override void Dispose(bool disposing){if(disposing)updateView.Dispose();base.Dispose(disposing);}
    }
    // Paints the rounded row groups behind the controls.
    internal sealed class SettingsSheet : ResizePanel {
        internal Palette Colors=Palette.Create(false);
        internal readonly List<Rectangle> Cards=new List<Rectangle>();
        internal readonly List<int> Dividers=new List<int>();
        protected override void OnPaint(PaintEventArgs e){
            base.OnPaint(e);e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            foreach(var card in Cards)PaintUi.Box(e.Graphics,card,12,Colors.Surface,Colors.Border);
            e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.None;
            using(var p=new Pen(Colors.Border))foreach(int y in Dividers)e.Graphics.DrawLine(p,1,y,Width-2,y);
        }
    }
    // A field that opens a themed menu of choices.
    internal sealed class DropdownField : Control {
        sealed class MenuColors : ProfessionalColorTable {
            readonly Palette colors;
            internal MenuColors(Palette palette){colors=palette;UseSystemColors=false;}
            public override Color MenuBorder{get{return colors.Border;}}
            public override Color ToolStripDropDownBackground{get{return colors.Surface;}}
            public override Color MenuItemSelected{get{return colors.Active;}}
            public override Color MenuItemBorder{get{return colors.Active;}}
            public override Color ImageMarginGradientBegin{get{return colors.Surface;}}
            public override Color ImageMarginGradientMiddle{get{return colors.Surface;}}
            public override Color ImageMarginGradientEnd{get{return colors.Surface;}}
            public override Color CheckBackground{get{return colors.Surface;}}
            public override Color CheckSelectedBackground{get{return colors.Active;}}
            public override Color CheckPressedBackground{get{return colors.Active;}}
        }
        // Rows fill the menu's whole width; the current choice stays pale blue.
        sealed class MenuRenderer : ToolStripProfessionalRenderer {
            readonly Palette colors;
            internal MenuRenderer(Palette palette):base(new MenuColors(palette)){colors=palette;}
            protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e){
                bool current=Equals(e.Item.Tag,true),hot=e.Item.Selected;
                Color fill=current?Motion.Mix(colors.Surface,colors.Blue,hot?0.32:0.22):hot?colors.Active:colors.Surface;
                using(var b=new SolidBrush(fill))e.Graphics.FillRectangle(b,new Rectangle(Point.Empty,e.Item.Size));
            }
            protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e){
                e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using(var path=PaintUi.Round(new Rectangle(0,0,e.ToolStrip.Width-1,e.ToolStrip.Height-1),MenuRadius))using(var p=new Pen(colors.Border))e.Graphics.DrawPath(p,path);
            }
        }
        const double MenuMilliseconds=130;
        const int MenuRadius=8,MenuInset=4;
        readonly System.Diagnostics.Stopwatch menuClock=new System.Diagnostics.Stopwatch();
        FrameClock menuFrames;
        bool closingMenu,finishingMenu;
        double menuFrom,menuLevel;
        internal bool Animating{get{return menuFrames!=null;}}
        readonly KeyValuePair<string,string>[] items;
        internal readonly ContextMenuStrip Menu=new ContextMenuStrip{ShowImageMargin=false,ShowCheckMargin=false};
        bool hover,dismissedByThisClick;
        internal Palette Colors=Palette.Create(false);
        internal string Value;
        internal event Action<string> Chosen;
        internal DropdownField(KeyValuePair<string,string>[] choices){
            items=choices;TabStop=true;Cursor=Cursors.Hand;AccessibleRole=AccessibleRole.ComboBox;
            SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Selectable|ControlStyles.StandardClick,true);
            Menu.Opened+=delegate{Invalidate();};Menu.Closed+=delegate{Invalidate();};
            Menu.Closing+=delegate(object sender,ToolStripDropDownClosingEventArgs e){
                NoteClosing(e.CloseReason,Cursor.Position);
                if(finishingMenu||!Motion.Enabled||!IsHandleCreated)return;
                // Keep it on screen while it folds away; the animation closes it for real.
                e.Cancel=true;if(!closingMenu)AnimateMenu(true);
            };
        }
        internal bool IsOpen{get{return Menu.Visible&&!closingMenu;}}
        void AnimateMenu(bool closing){
            closingMenu=closing;menuFrom=menuLevel;menuClock.Restart();Invalidate();
            if(menuFrames==null){menuFrames=new FrameClock(this,MenuFrame);menuFrames.Start();}
        }
        void MenuFrame(){
            double t=Math.Min(1,menuClock.ElapsedMilliseconds/MenuMilliseconds),goal=closingMenu?0:1;
            ApplyMenuLevel(menuFrom+(goal-menuFrom)*Motion.EaseOut(t));
            if(t<1)return;
            menuFrames.Stop();menuFrames=null;
            if(closingMenu){finishingMenu=true;try{Menu.Close();}finally{finishingMenu=false;closingMenu=false;}}
            else ClearMenuMotion();
            Invalidate();
        }
        void ApplyMenuLevel(double level){
            menuLevel=level;Menu.Opacity=Math.Max(0.01,level);
            ShapeMenu(Math.Max(1,(int)Math.Round(Menu.Height*level)));
        }
        void ShapeMenu(int visibleHeight){
            var old=Menu.Region;
            using(var path=PaintUi.Round(new Rectangle(0,0,Menu.Width,Menu.Height),MenuRadius)){var shape=new Region(path);shape.Intersect(new Rectangle(0,0,Menu.Width,visibleHeight));Menu.Region=shape;}
            if(old!=null)old.Dispose();
        }
        void ClearMenuMotion(){ShapeMenu(Menu.Height);Menu.Opacity=1;menuLevel=1;}
        internal string Arrow{get{return IsOpen?"up":"chevron";}}
        // The menu closes on mouse down, before this field sees the click, so a click on the
        // field while it is open must be remembered or it would open the menu straight again.
        internal void NoteClosing(ToolStripDropDownCloseReason reason,Point screen){
            if(reason!=ToolStripDropDownCloseReason.AppClicked)return;
            dismissedByThisClick=IsHandleCreated&&ClientRectangle.Contains(PointToClient(screen));
        }
        internal void TestClick(){OnClick(EventArgs.Empty);OnMouseUp(new MouseEventArgs(MouseButtons.Left,1,0,0,0));}
        internal bool Choose(string key){
            if(key==Value||!items.Any(i=>i.Key==key))return false;
            if(Chosen!=null)Chosen(key);
            return true;
        }
        void Open(){
            if(closingMenu&&Menu.Visible){AnimateMenu(false);return;}
            foreach(ToolStripItem old in Menu.Items.Cast<ToolStripItem>().ToArray())old.Dispose();
            Menu.Items.Clear();Menu.Font=Font;Menu.BackColor=Colors.Surface;Menu.ForeColor=Colors.Text;Menu.MinimumSize=new Size(Width,0);Menu.Padding=new Padding(1,MenuInset,1,MenuInset);Menu.DropShadowEnabled=false;Menu.Renderer=new MenuRenderer(Colors);
            foreach(var pair in items){
                string key=pair.Key;var item=new ToolStripMenuItem(L.Text(pair.Value)){ForeColor=Colors.Text,Tag=key==Value,Margin=Padding.Empty,AutoSize=false,Size=new Size(Width-2,34)};
                item.Click+=delegate{Choose(key);};Menu.Items.Add(item);
            }
            if(!Motion.Enabled||!IsHandleCreated){Menu.Show(this,new Point(0,Height+2));ClearMenuMotion();return;}
            // Fully clipped first, so no frame shows the whole menu before it unfolds.
            menuLevel=0;Menu.Show(this,new Point(0,Height+2));ApplyMenuLevel(0);AnimateMenu(false);
        }
        protected override void OnClick(EventArgs e){
            base.OnClick(e);Focus();
            if(dismissedByThisClick)return;
            if(IsOpen)Menu.Close();else Open();
        }
        protected override void OnMouseUp(MouseEventArgs e){base.OnMouseUp(e);dismissedByThisClick=false;}
        protected override bool IsInputKey(Keys key){return key==Keys.Down||base.IsInputKey(key);}
        protected override void OnKeyDown(KeyEventArgs e){if(e.KeyCode==Keys.Space||e.KeyCode==Keys.Enter||e.KeyCode==Keys.Down){e.Handled=true;Open();}base.OnKeyDown(e);}
        protected override void OnGotFocus(EventArgs e){base.OnGotFocus(e);Invalidate();}
        protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);Invalidate();}
        protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
        protected override void OnPaint(PaintEventArgs e){
            var g=e.Graphics;g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using(var b=new SolidBrush(BackColor))g.FillRectangle(b,ClientRectangle);
            PaintUi.Box(g,new Rectangle(0,0,Width-1,Height-1),8,hover?Colors.Subtle:Colors.Surface,Focused&&ShowFocusCues?Colors.SelectionBorder:Colors.Border);
            string text=items.Where(i=>i.Key==Value).Select(i=>L.Text(i.Value)).FirstOrDefault()??"";
            PaintUi.Text(g,text,Font,new Rectangle(12,0,Width-40,Height),Colors.Text);
            PaintUi.Icon(g,Arrow,new Rectangle(Width-28,(Height-16)/2,16,16),Colors.Muted);
        }
        protected override void Dispose(bool disposing){if(disposing){if(menuFrames!=null){menuFrames.Stop();menuFrames=null;}Menu.Dispose();}base.Dispose(disposing);}
    }
    // Still a CheckBox, so keyboard use, accessibility and wheel handling stay as they were.
    // Its row shows the label, so only the switch itself is painted.
    internal sealed class ToggleSwitch : CheckBox {
        const double SlideMilliseconds=130;
        const int TrackWidth=44,TrackHeight=24,Thumb=18;
        internal Palette Colors=Palette.Create(false);
        internal double Level;
        readonly Timer motion=new Timer{Interval=15};
        readonly System.Diagnostics.Stopwatch clock=new System.Diagnostics.Stopwatch();
        double from;
        internal ToggleSwitch(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);Cursor=Cursors.Hand;motion.Tick+=delegate{Advance();};}
        protected override void OnCheckedChanged(EventArgs e){
            base.OnCheckedChanged(e);
            if(!Motion.Enabled||!IsHandleCreated||!Visible){motion.Stop();Level=Checked?1:0;Invalidate();return;}
            from=Level;clock.Restart();motion.Start();
        }
        void Advance(){
            double t=clock.ElapsedMilliseconds/SlideMilliseconds,goal=Checked?1:0;
            Level=from+(goal-from)*Motion.EaseOut(t);
            if(t>=1){Level=goal;motion.Stop();}
            Invalidate();
        }
        protected override void OnPaint(PaintEventArgs e){
            var g=e.Graphics;g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using(var b=new SolidBrush(BackColor))g.FillRectangle(b,ClientRectangle);
            int left=Width-TrackWidth-2,top=(Height-TrackHeight)/2;var fill=Motion.Mix(Colors.Track,Colors.Blue,Level);
            PaintUi.Box(g,new Rectangle(left,top,TrackWidth,TrackHeight),TrackHeight/2,fill,fill);
            int inset=(TrackHeight-Thumb)/2,x=left+inset+(int)Math.Round((TrackWidth-Thumb-2*inset)*Level);
            using(var b=new SolidBrush(Color.White))g.FillEllipse(b,x,top+inset,Thumb,Thumb);
            if(Focused&&ShowFocusCues)using(var path=PaintUi.Round(new Rectangle(left-1,top-2,TrackWidth+1,TrackHeight+3),TrackHeight/2+1))using(var p=new Pen(Colors.SelectionBorder))g.DrawPath(p,path);
        }
        protected override void Dispose(bool disposing){if(disposing){motion.Stop();motion.Dispose();}base.Dispose(disposing);}
    }
}
