using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CMCP {
    // Every custom-painted editor surface must discard its retained pixels
    // when resized, including the input hosts and the scrollable parent.
    internal class ResizePanel : Panel {
        internal ResizePanel(){DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw|ControlStyles.AllPaintingInWmPaint,true);}
        protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);Invalidate(true);}
    }
    // Keep WinForms scrolling/focus navigation, without native white chrome.
    internal class EditorViewport : ResizePanel {
        [DllImport("user32.dll")] static extern bool ShowScrollBar(IntPtr window,int bar,bool show);
        [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window,int index);
        [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
        [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
        bool hiding;
        // Wheel notches glide to an accumulated target with a short ease-out instead
        // of jumping 120 px in one repaint. The first frame is applied while the wheel
        // message is handled; the timer finishes the rest, and any other scroll change
        // (focus into view, restored offset, layout clamp) cancels the glide.
        const double GlideMilliseconds=170,GlideFrame=16;
        readonly Timer glide=new Timer{Interval=8};
        readonly System.Diagnostics.Stopwatch glideClock=new System.Diagnostics.Stopwatch();
        int glideFrom,glideTarget,glideApplied;
        bool fineTimer;
        internal bool Gliding {get{return glide.Enabled;}}
        internal EditorViewport(){glide.Tick+=delegate{if(-AutoScrollPosition.Y!=glideApplied)StopGlide();else{GlideStep();Update();}};}
        bool GlideWheel(int delta){
            int max=Math.Max(0,DisplayRectangle.Height-ClientSize.Height),current=-AutoScrollPosition.Y;
            if(delta==0||max==0)return false;
            if(!glide.Enabled)glideTarget=current;
            glideTarget=Math.Max(0,Math.Min(max,glideTarget-delta));
            glideFrom=current;glideClock.Restart();
            // The default 15.6 ms system tick would cap the glide near 64 frames per second.
            if(!fineTimer){fineTimer=true;try{timeBeginPeriod(1);}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}}
            glide.Start();GlideStep();
            return true;
        }
        void GlideStep(){
            double t=Math.Min(1,(glideClock.Elapsed.TotalMilliseconds+GlideFrame)/GlideMilliseconds);
            int next=glideFrom+(int)Math.Round((glideTarget-glideFrom)*(1-Math.Pow(1-t,3)));
            AutoScrollPosition=new Point(-AutoScrollPosition.X,next);glideApplied=-AutoScrollPosition.Y;HideBars();
            if(t>=1)StopGlide();
        }
        void StopGlide(){glide.Stop();if(fineTimer){fineTimer=false;try{timeEndPeriod(1);}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}}}
        protected override CreateParams CreateParams { get { var value=base.CreateParams;value.Style&=~0x00300000;return value; } }
        void HideBars(){if(hiding||!IsHandleCreated)return;hiding=true;try{ShowScrollBar(Handle,3,false);}finally{hiding=false;}}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);HideBars();}
        // AutoScroll re-shows the native bar for an instant while the wheel scrolls; if it
        // took client space, the usable width dropped by a bar width and card right
        // edges were clipped or laid out narrower. The client area is therefore always
        // the whole (borderless) window, and the hidden bar never takes mouse input.
        protected override void WndProc(ref Message m){
            if(m.Msg==0x83){m.Result=IntPtr.Zero;return;}
            if(m.Msg==0x20a&&GlideWheel((short)(((long)m.WParam>>16)&0xffff))){m.Result=IntPtr.Zero;return;}
            base.WndProc(ref m);
            if(m.Msg==0x84&&(m.Result==(IntPtr)6||m.Result==(IntPtr)7))m.Result=(IntPtr)1;
            if(m.Msg==0x85||m.Msg==0x5||m.Msg==0x7d||m.Msg==0x47||m.Msg==0x20a)HideBars();
        }
        internal bool NativeBarsVisible {get{return IsHandleCreated&&(GetWindowLong(Handle,-16)&0x00300000)!=0;}}
        // Test trace: every usable width this viewport passed through, including transient ones.
        internal readonly System.Collections.Generic.List<int> ClientWidthsSeen=new System.Collections.Generic.List<int>();
        internal bool TraceClientWidth;
        protected override void OnClientSizeChanged(EventArgs e){if(TraceClientWidth)ClientWidthsSeen.Add(ClientSize.Width);base.OnClientSizeChanged(e);}
        internal void Wheel(int delta){StopGlide();base.OnMouseWheel(new MouseEventArgs(MouseButtons.None,0,20,20,delta));HideBars();}
        protected override void Dispose(bool disposing){if(disposing){StopGlide();glide.Dispose();}base.Dispose(disposing);}
    }
    internal sealed class RoundedSheet : ResizePanel {
        internal Palette Colors = Palette.Create(false);
        internal RoundedSheet() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            PaintUi.Box(e.Graphics, new Rectangle(1,1,Width-3,Height-3),15,Colors.Surface,Colors.Border);
        }
    }

    internal sealed class EditorInput : ResizePanel {
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,string lParam);
        internal readonly TextBox Box = new TextBox { BorderStyle=BorderStyle.None };
        internal Palette Colors = Palette.Create(false);
        string cue="";
        // The grey hint inside an empty field. A multi-line box has none.
        internal string Cue { get { return cue; } set { cue=value??"";ApplyCue(); } }
        void ApplyCue(){if(Box.IsHandleCreated&&!Box.Multiline)SendMessage(Box.Handle,0x1501,(IntPtr)1,L.Text(cue));}
        internal EditorInput() { Height=40;Controls.Add(Box);Box.GotFocus+=delegate{Invalidate();};Box.LostFocus+=delegate{Invalidate();};Box.HandleCreated+=delegate{ApplyCue();}; }
        internal void Apply(Palette colors) { Colors=colors;var fill=Enabled?colors.Surface:colors.Subtle;BackColor=colors.Surface;Box.BackColor=fill;Box.ForeColor=Enabled?colors.Text:colors.Muted;Invalidate(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e);Apply(Colors); }
        protected override void OnLayout(LayoutEventArgs e) { base.OnLayout(e);Box.Bounds=Box.Multiline?new Rectangle(14,9,Math.Max(1,Width-28),Math.Max(1,Height-18)):new Rectangle(14,(Height-Box.PreferredHeight)/2,Math.Max(1,Width-28),Box.PreferredHeight); }
        protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e);e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;PaintUi.Box(e.Graphics,new Rectangle(1,1,Width-3,Height-3),9,Enabled?Colors.Surface:Colors.Subtle,Box.Focused?Colors.SelectionBorder:Colors.Border); }
    }

    // A page hosted by Manager; it never owns a Form or nested message loop. Categories on the left
    // like the settings page. All inputs live for the whole page, so moving between categories keeps what was typed.
    internal sealed class TargetEditorPage : UserControl {
        sealed class Row { internal Label Title;internal Control Main;internal int MainWidth;internal int Height=56;internal readonly List<Control> Extras=new List<Control>(); }
        sealed class Section { internal Label Heading,Note;internal readonly List<Row> Rows=new List<Row>(); }
        sealed class Category { internal string Title,Glyph;internal ModernButton Tab;internal readonly List<Section> Sections=new List<Section>(); }
        const int ColumnWidth=680,RowPadding=16,LabelWidth=124;
        internal readonly ModernButton Back = new ModernButton { Glyph="back",Text="返回",Nav=true,AccessibleName="返回设备列表" };
        internal readonly ModernButton Save = new ModernButton { Glyph="check",Text="保存",Primary=true,AccessibleName="保存设备" };
        internal readonly EditorInput NameInput = new EditorInput(), NoteInput = new EditorInput{Height=64}, UrlInput = new EditorInput(), PasswordInput = new EditorInput();
        internal readonly EditorInput HostInput = new EditorInput(), PortInput = new EditorInput(), UserInput = new EditorInput(), SshSecretInput = new EditorInput(), KeyInput = new EditorInput();
        internal readonly ToggleSwitch Remember = new ToggleSwitch{Size=new Size(48,30)}, HideAddress = new ToggleSwitch{Size=new Size(48,30)};
        internal readonly DropdownField MethodField = new DropdownField(new[]{new KeyValuePair<string,string>("password","密码"),new KeyValuePair<string,string>("key","公钥")}){Height=38,Value="password"};
        internal bool AutoLogin {get{return Remember.Checked;}}
        internal bool IsNew { get { return TargetName.Length==0; } }
        internal string Password { get { return PasswordInput.Box.Text; } }
        readonly ModernButton choose = new ModernButton { Text="选择本机图片",Neutral=true,CenterText=true,Size=new Size(156,36) }, reset = new ModernButton { Text="恢复默认",CenterText=true,Size=new Size(90,36) };
        readonly ModernButton browse = new ModernButton { Text="浏览…",Neutral=true,CenterText=true,Size=new Size(84,38) }, forget = new ModernButton { Text="清除",Neutral=true,CenterText=true,Size=new Size(64,38) };
        readonly Label pageTitle = new Label{TextAlign=ContentAlignment.MiddleLeft}, group = new Label(), error = new Label{TextAlign=ContentAlignment.MiddleLeft};
        readonly PictureBox icon = new PictureBox { SizeMode=PictureBoxSizeMode.Zoom,Size=new Size(44,44) };
        readonly ResizePanel side = new ResizePanel{Dock=DockStyle.Left,Width=212}, top = new ResizePanel{Dock=DockStyle.Top,Height=56}, footer = new ResizePanel{Dock=DockStyle.Bottom,Height=78};
        internal readonly EditorViewport viewport = new EditorViewport{Dock=DockStyle.Fill,AutoScroll=true};
        readonly SettingsSheet sheet = new SettingsSheet();
        readonly LocalToolTip tips = new LocalToolTip();
        readonly Category general=new Category{Title="常规",Glyph="profile"},web=new Category{Title="共享网页登录",Glyph="monitor"},ssh=new Category{Title="SSH 登录",Glyph="terminal"};
        readonly List<Category> categories=new List<Category>();
        Row secretRow,keyRow;
        Category current;
        Palette colors;
        bool laying,preferSsh;
        internal Action<Control,int,Action> AnimateContent;
        internal event Action BackRequested, SaveRequested;
        internal readonly string TargetName;
        readonly string initialUrl;
        readonly bool storedAutoPassword;
        readonly SshLogin savedSsh;
        bool forgetSecret;
        internal string DisplayName { get { return NameInput.Box.Text.Trim(); } }
        internal string Note { get { return NoteInput.Box.Text.Trim(); } }
        internal string Url { get { return UrlInput.Box.Text.Trim(); } }
        internal string IconData;
        internal bool HasWeb { get { return Url.Length>0; } }
        internal bool HasSsh { get { return HostInput.Box.Text.Trim().Length>0||UserInput.Box.Text.Trim().Length>0||(UsesKey&&KeyInput.Box.Text.Trim().Length>0); } }
        internal bool UsesKey { get { return MethodField.Value=="key"; } }
        internal bool PreferSsh { get { return preferSsh; } }
        internal string CurrentCategory { get { return current.Title; } }

        internal TargetEditorPage(Target target, CardPreference preference, Palette palette, SshLogin login = null) {
            TargetName=target.Name;IconData=preference.icon;Dock=DockStyle.Fill;Font=UiFont.Points(11F);colors=palette;
            initialUrl=target.Url;storedAutoPassword=target.AutoLogin&&target.HasSavedPassword;savedSsh=login;
            DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw|ControlStyles.AllPaintingInWmPaint,true);
            side.Font=UiFont.Points(10.5F);sheet.Font=UiFont.Points(10.5F);group.Font=UiFont.Points(9F);pageTitle.Font=new Font(UiFont.Points(13F),FontStyle.Bold);
            NameInput.Box.MaxLength=80;NameInput.Box.Text=preference.label;
            NoteInput.Box.Multiline=true;NoteInput.Box.MaxLength=200;NoteInput.Box.Text=preference.note??"";
            UrlInput.Box.MaxLength=300;UrlInput.Box.Text=target.Url;UrlInput.Cue="https://";
            PasswordInput.Box.UseSystemPasswordChar=true;PasswordInput.Box.MaxLength=256;PasswordInput.Cue=target.HasSavedPassword?"已加密保存；同一地址留空保留":"手动共享网页登录可留空";
            Remember.Checked=target.AutoLogin;HideAddress.Checked=preference.hideAddress;HideAddress.AccessibleName=L.Text("隐藏网址和 IP");
            HostInput.Box.MaxLength=253;PortInput.Box.MaxLength=5;UserInput.Box.MaxLength=64;KeyInput.Box.MaxLength=512;
            SshSecretInput.Box.UseSystemPasswordChar=true;SshSecretInput.Box.MaxLength=256;
            HostInput.Cue="域名或 IP";PortInput.Box.Text="22";UserInput.Cue="root";
            if(login!=null){HostInput.Box.Text=login.host;PortInput.Box.Text=Convert.ToString(login.port);UserInput.Box.Text=login.username;MethodField.Value=login.method;KeyInput.Box.Text=login.keyPath;preferSsh=login.active;}
            if(target.Url.Length==0&&login!=null)preferSsh=true;
            if(preference.loginMode.Length>0)preferSsh=preference.loginMode=="ssh";
            MethodField.Chosen+=key=>{MethodField.Value=key;MethodField.Invalidate();forgetSecret=false;RefreshMethod();LayoutSheet();ApplyVisibility();};
            BuildCategories();
            Back.Click+=delegate{if(BackRequested!=null)BackRequested();};
            Save.Click+=delegate{if(ValidateFields()&&SaveRequested!=null)SaveRequested();};
            choose.Click+=delegate{using(var picker=new OpenFileDialog{Filter="图标图片 (*.png;*.jpg;*.jpeg;*.ico)|*.png;*.jpg;*.jpeg;*.ico",CheckFileExists=true}){
                if(picker.ShowDialog(FindForm())!=DialogResult.OK)return;
                try{IconData=UiPreferences.ImportIcon(picker.FileName);RefreshIcon();ShowError("");}catch(Exception ex){ShowError(ex.Message);}
            }};
            reset.Click+=delegate{IconData="";RefreshIcon();};
            browse.Click+=delegate{using(var picker=new OpenFileDialog{CheckFileExists=true,Title=L.Text("选择私钥文件")}){
                string folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ssh");if(Directory.Exists(folder))picker.InitialDirectory=folder;
                if(picker.ShowDialog(FindForm())==DialogResult.OK)KeyInput.Box.Text=picker.FileName;
            }};
            forget.Click+=delegate{forgetSecret=true;SshSecretInput.Box.Clear();RefreshMethod();LayoutSheet();ApplyVisibility();};
            foreach(var input in new[]{UrlInput,HostInput,UserInput,KeyInput})input.Box.TextChanged+=delegate{RefreshTabs();};
            foreach(var input in new[]{HostInput,UserInput,KeyInput})input.Box.TextChanged+=delegate{RefreshMethod();LayoutSheet();ApplyVisibility();};
            top.Controls.Add(pageTitle);pageTitle.Bounds=new Rectangle(58,0,420,55);
            top.Paint+=delegate(object sender,PaintEventArgs e){
                e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                PaintUi.Icon(e.Graphics,current.Glyph,new Rectangle(28,17,22,22),colors.Text);
                using(var p=new Pen(colors.Border))e.Graphics.DrawLine(p,0,top.Height-1,top.Width,top.Height-1);
            };
            side.Paint+=delegate(object sender,PaintEventArgs e){using(var p=new Pen(colors.Border))e.Graphics.DrawLine(p,side.Width-1,0,side.Width-1,side.Height);};
            side.Controls.AddRange(new Control[]{Back,group});
            foreach(var category in categories){
                var item=category;item.Tab=new ModernButton{Glyph=item.Glyph,Text=item.Title,Nav=true};
                item.Tab.Click+=delegate{Show(item,true);};side.Controls.Add(item.Tab);
            }
            footer.Controls.Add(Save);footer.Controls.Add(error);
            viewport.Controls.Add(sheet);
            Controls.Add(viewport);Controls.Add(footer);Controls.Add(top);Controls.Add(side);
            Save.Text=IsNew?"添加":"保存";group.Text=L.Text(IsNew?"添加设备":"编辑设备");
            tips.SetToolTip(Back,"返回列表，不保存本次修改");tips.SetToolTip(choose,"选择 PNG、JPEG 或 ICO，最多 1 MiB");tips.SetToolTip(reset,"移除自定义图标，使用默认图标");tips.SetToolTip(Save,"保存这台设备的修改");
            tips.SetToolTip(Remember,"仅用于共享网页登录。密码使用当前 Windows 账户加密，不会显示原密码；旧版仍沿用原有登录方式。");
            tips.SetToolTip(SshSecretInput,"密码或口令使用当前 Windows 账户加密，不会显示原内容。");
            side.SizeChanged+=delegate{LayoutSide();};viewport.SizeChanged+=delegate{PlaceSheet();};sheet.SizeChanged+=delegate{LayoutSheet();};
            footer.SizeChanged+=delegate{Save.Bounds=new Rectangle(Math.Max(28,footer.Width-156),18,128,42);error.Bounds=new Rectangle(28,8,Math.Max(10,footer.Width-200),62);};
            current=general;
            RefreshMethod();RefreshTabs();LayoutSide();RefreshIcon();Apply(colors);PlaceSheet();Show(general,false);
        }
        Section AddSection(Category category,string text,string note=null){
            var section=new Section{Heading=new Label{Text=L.Text(text),Font=new Font(sheet.Font,FontStyle.Bold),TextAlign=ContentAlignment.MiddleLeft}};
            sheet.Controls.Add(section.Heading);
            if(note!=null){section.Note=new Label{Text=L.Text(note),Font=UiFont.Points(9F)};sheet.Controls.Add(section.Note);}
            category.Sections.Add(section);return section;
        }
        Row AddRow(Section section,string title,Control main,int mainWidth=0,params Control[] extras){
            var row=new Row{Title=new Label{Text=L.Text(title),Font=sheet.Font,TextAlign=ContentAlignment.MiddleLeft},Main=main,MainWidth=mainWidth};
            row.Extras.AddRange(extras);
            sheet.Controls.Add(row.Title);sheet.Controls.Add(main);foreach(var extra in extras)sheet.Controls.Add(extra);
            section.Rows.Add(row);return row;
        }
        void BuildCategories(){
            categories.AddRange(new[]{general,web,ssh});
            var looks=AddSection(general,"外观");
            AddRow(looks,"图标",icon,44,reset,choose);
            AddRow(looks,"名称",NameInput);
            AddRow(looks,"备注",NoteInput).Height=84;
            var display=AddSection(general,"显示");AddRow(display,"隐藏网址和 IP",HideAddress,48);
            var address=AddSection(web,"连接");
            AddRow(address,"网页地址",UrlInput);
            AddRow(address,"密码",PasswordInput);
            var auto=AddSection(web,"自动登录","打开后，保存时不登录；启动连接后自动尝试一次。新登录可能让旧页面下线。关闭会删除共享模式保存的密码。");
            AddRow(auto,"记住密码",Remember,48);
            var link=AddSection(ssh,"连接","SSH 只用来打开终端，不经过 MCP 连接。");
            AddRow(link,"主机",HostInput);
            AddRow(link,"端口",PortInput,96);
            var login=AddSection(ssh,"认证");
            AddRow(login,"方法",MethodField);
            AddRow(login,"用户名",UserInput);
            secretRow=AddRow(login,"密码",SshSecretInput,0,forget);
            keyRow=AddRow(login,"私钥",KeyInput,0,browse);
        }
        bool SecretStillUsable { get {
            if(savedSsh==null||forgetSecret||String.IsNullOrEmpty(savedSsh.secret)||savedSsh.method!=MethodField.Value)return false;
            if(!String.Equals(savedSsh.host,HostInput.Box.Text.Trim(),StringComparison.OrdinalIgnoreCase)||!String.Equals(savedSsh.username,UserInput.Box.Text.Trim(),StringComparison.Ordinal))return false;
            return !UsesKey||String.Equals(savedSsh.keyPath,KeyInput.Box.Text.Trim(),StringComparison.OrdinalIgnoreCase);
        } }
        // Password keeps the private key row greyed out, as in the reference design; a key moves it first.
        void RefreshMethod(){
            bool key=UsesKey,saved=SecretStillUsable;
            KeyInput.Enabled=browse.Enabled=key;
            secretRow.Title.Text=L.Text(key?"私钥口令":"密码");
            SshSecretInput.Cue=saved?"已加密保存；留空保留":"可留空，连接时在终端输入";
            forget.Tag=saved;
            var rows=ssh.Sections[1].Rows;rows.Remove(secretRow);rows.Remove(keyRow);
            if(key){rows.Add(keyRow);rows.Add(secretRow);}else{rows.Add(secretRow);rows.Add(keyRow);}
            keyRow.Title.ForeColor=key?colors.Text:colors.Muted;
            ApplyVisibility();
        }
        void RefreshTabs(){
            if(web.Tab==null)return;
            web.Tab.Dot=web.Tab.DotOk=HasWeb;ssh.Tab.Dot=ssh.Tab.DotOk=HasSsh;
            web.Tab.Invalidate();ssh.Tab.Invalidate();
        }
        void LayoutSide(){
            int width=side.Width-20;
            Back.Bounds=new Rectangle(10,14,width,36);group.Bounds=new Rectangle(20,60,width-20,20);
            int y=84;foreach(var category in categories){if(category.Tab!=null){category.Tab.Bounds=new Rectangle(10,y,width,38);y+=40;}}
            side.Invalidate();
        }
        void PlaceSheet(){
            int client=viewport.ClientSize.Width,pad=client<560?18:28,width=Math.Max(200,Math.Min(ColumnWidth,client-2*pad));
            sheet.SetBounds((client-width)/2,20+viewport.AutoScrollPosition.Y,width,sheet.Height);
        }
        void LayoutSheet(){
            if(laying)return;
            laying=true;
            try{
                int width=sheet.ClientSize.Width,shownHeight=0;
                sheet.Cards.Clear();sheet.Dividers.Clear();
                foreach(var category in categories){
                    bool shown=category==current;int y=0;
                    foreach(var section in category.Sections){
                        section.Heading.Bounds=new Rectangle(0,y,width,24);y+=32;
                        int cardTop=y;bool first=true;
                        foreach(var row in section.Rows){
                            if(!first&&shown)sheet.Dividers.Add(y);
                            row.Title.Bounds=new Rectangle(RowPadding,y+2,LabelWidth,row.Height-4);
                            int right=width-RowPadding,left=RowPadding+LabelWidth+8;
                            foreach(var extra in row.Extras){
                                if(!ExtraShown(extra))continue;
                                extra.Location=new Point(right-extra.Width,y+(row.Height-extra.Height)/2);right=extra.Left-8;
                            }
                            int mainWidth=row.MainWidth>0?row.MainWidth:Math.Max(40,right-left);
                            row.Main.Bounds=new Rectangle(row.Main is ToggleSwitch?right-mainWidth:left,y+(row.Height-row.Main.Height)/2,mainWidth,row.Main.Height);
                            y+=row.Height;first=false;
                        }
                        if(shown)sheet.Cards.Add(new Rectangle(0,cardTop,Math.Max(1,width-1),y-cardTop));
                        if(section.Note!=null){
                            int height=TextRenderer.MeasureText(section.Note.Text,section.Note.Font,new Size(Math.Max(60,width-8),0),TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix).Height+2;
                            section.Note.Bounds=new Rectangle(4,y+8,Math.Max(60,width-8),height);y+=height+8;
                        }
                        y+=22;
                    }
                    if(shown)shownHeight=y;
                }
                if(sheet.Height!=shownHeight)sheet.Height=shownHeight;
                viewport.AutoScrollMinSize=new Size(0,shownHeight+44);
                sheet.Invalidate();
            }finally{laying=false;}
        }
        bool ExtraShown(Control extra){return extra!=forget||Equals(forget.Tag,true);}
        void ApplyVisibility(){
            if(current==null)return;
            foreach(var category in categories){
                bool shown=category==current;
                foreach(var section in category.Sections){
                    section.Heading.Visible=shown;if(section.Note!=null)section.Note.Visible=shown;
                    foreach(var row in section.Rows){row.Title.Visible=shown;row.Main.Visible=shown;foreach(var extra in row.Extras)extra.Visible=shown&&ExtraShown(extra);}
                }
            }
        }
        void Show(Category category,bool animate){
            if(animate&&category==current)return;
            int direction=categories.IndexOf(category)-categories.IndexOf(current);
            Action swap=delegate{
                current=category;pageTitle.Text=L.Text(category.Title);
                foreach(var item in categories)if(item.Tab!=null){item.Tab.Selected=item==category;item.Tab.Invalidate();}
                viewport.AutoScrollPosition=Point.Empty;LayoutSheet();ApplyVisibility();PlaceSheet();top.Invalidate();
            };
            if(animate&&AnimateContent!=null)AnimateContent(viewport,direction>0?1:-1,swap);else swap();
        }
        internal void ShowGeneral(){Show(general,false);}
        internal void ShowWeb(){Show(web,false);}
        internal void ShowSsh(){Show(ssh,false);}
        internal bool LayoutFits { get { return NameInput.Right<=sheet.Width && UrlInput.Right<=sheet.Width && HostInput.Right<=sheet.Width && browse.Right<=sheet.Width && Save.Right<=footer.Width && Back.Right<=side.Width; } }
        internal void Apply(Palette palette) {
            colors=palette;tips.Apply(colors);
            BackColor=top.BackColor=viewport.BackColor=footer.BackColor=sheet.BackColor=colors.Page;sheet.Colors=colors;
            side.BackColor=group.BackColor=colors.Side;group.ForeColor=colors.Muted;
            pageTitle.ForeColor=colors.Text;pageTitle.BackColor=colors.Page;error.ForeColor=colors.Danger;error.BackColor=colors.Page;
            icon.BackColor=colors.Surface;
            foreach(var b in new[]{Back,Save}){b.Colors=colors;b.BackColor=b==Back?colors.Side:colors.Page;b.Invalidate();}
            foreach(var category in categories){
                if(category.Tab!=null){category.Tab.Colors=colors;category.Tab.BackColor=colors.Side;category.Tab.Invalidate();}
                foreach(var section in category.Sections){
                    section.Heading.BackColor=colors.Page;section.Heading.ForeColor=colors.Text;
                    if(section.Note!=null){section.Note.BackColor=colors.Page;section.Note.ForeColor=colors.Muted;}
                    foreach(var row in section.Rows){
                        row.Title.BackColor=colors.Surface;row.Title.ForeColor=colors.Text;
                        foreach(var control in new[]{row.Main}.Concat(row.Extras))ApplyControl(control);
                    }
                }
            }
            if(keyRow!=null)keyRow.Title.ForeColor=UsesKey?colors.Text:colors.Muted;
            RefreshIcon();sheet.Invalidate();Invalidate(true);
        }
        void ApplyControl(Control control){
            var input=control as EditorInput;var button=control as ModernButton;var toggle=control as ToggleSwitch;var field=control as DropdownField;var track=control as RoundedSheet;
            if(input!=null)input.Apply(colors);
            if(button!=null){button.Colors=colors;button.BackColor=colors.Surface;button.Invalidate();}
            if(toggle!=null){toggle.Colors=colors;toggle.BackColor=colors.Surface;toggle.Invalidate();}
            if(field!=null){field.Colors=colors;field.BackColor=colors.Surface;field.Invalidate();}
            if(track!=null){track.Colors=colors;track.BackColor=colors.Surface;foreach(var option in track.Controls.OfType<ModernButton>()){option.Colors=colors;option.BackColor=colors.Surface;option.Invalidate();}}
        }
        internal void ShowError(string message) { error.Text=L.Message(message); }
        internal void SetBusy(bool busy){
            foreach(var control in new Control[]{Save,Back,choose,reset,browse,forget,NameInput,NoteInput,UrlInput,PasswordInput,Remember,HideAddress,HostInput,PortInput,UserInput,SshSecretInput,KeyInput,MethodField})control.Enabled=!busy;
            if(!busy)RefreshMethod();
        }
        bool Fail(Category category,string message){Show(category,false);ShowError(message);return false;}
        internal bool ValidateFields() {
            Uri parsed;
            if(DisplayName.Any(Char.IsControl))return Fail(general,"名称不能包含控制字符。");
            if(Note.Any(c=>Char.IsControl(c)&&c!='\r'&&c!='\n'))return Fail(general,"备注不能包含控制字符。");
            if(!HasWeb&&!HasSsh)return Fail(current==general?web:current,"请至少填写一种登录方式：共享网页地址或 SSH 主机。");
            if(HasWeb){
                if(!Uri.TryCreate(Url,UriKind.Absolute,out parsed)||parsed.Scheme!="https"||parsed.UserInfo.Length>0||parsed.AbsolutePath!="/"||parsed.Query.Length>0||parsed.Fragment.Length>0)return Fail(web,"请输入完整的 HTTPS 网页地址，不含路径或登录信息。");
                if(AutoLogin&&Password.Length==0&&(!storedAutoPassword||!String.Equals(Url.TrimEnd('/'),initialUrl.TrimEnd('/'),StringComparison.OrdinalIgnoreCase)))return Fail(web,"请填写自动登录密码；更换地址时需要重新填写。");
            }
            if(HasSsh){
                string problem=SshLogin.Problem(HostInput.Box.Text.Trim(),PortInput.Box.Text.Trim(),UserInput.Box.Text.Trim(),MethodField.Value,UsesKey?KeyInput.Box.Text.Trim():"");
                if(problem.Length>0)return Fail(ssh,problem);
                if(UsesKey&&!File.Exists(KeyInput.Box.Text.Trim()))return Fail(ssh,"找不到这个私钥文件。");
                if(UsesKey&&KeyInput.Box.Text.Trim().EndsWith(".pub",StringComparison.OrdinalIgnoreCase))return Fail(ssh,"这是公钥文件，请选择不带 .pub 的私钥文件。");
            }
            ShowError("");return true;
        }
        // Encrypts what was typed. A saved secret is kept only for the same host, user and method,
        // so it can never be sent to a server the user just typed in.
        internal SshLogin BuildSsh(string name){
            if(!HasSsh)return null;
            var login=new SshLogin{name=name,host=HostInput.Box.Text.Trim(),port=Int32.Parse(PortInput.Box.Text.Trim()),username=UserInput.Box.Text.Trim(),method=MethodField.Value,keyPath=UsesKey?KeyInput.Box.Text.Trim():""};
            string typed=SshSecretInput.Box.Text;
            login.secret=typed.Length>0?SshSecret.Protect(typed):SecretStillUsable?savedSsh.secret:"";
            login.active=!HasWeb||preferSsh;
            return login;
        }
        void RefreshIcon() {
            var previous=icon.Image;
            if(IconData.Length>0)icon.Image=UiPreferences.DecodeIcon(IconData);
            else {var bmp=new Bitmap(44,44);using(var g=Graphics.FromImage(bmp)){g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;PaintUi.Box(g,new Rectangle(1,1,41,41),11,colors.Subtle,colors.Border);PaintUi.Icon(g,"monitor",new Rectangle(11,11,22,22),colors.Blue);}icon.Image=bmp;}
            if(previous!=null)previous.Dispose();
        }
        protected override bool ProcessCmdKey(ref Message m, Keys keys) {
            if(keys==Keys.Escape){if(BackRequested!=null)BackRequested();return true;}
            if(keys==(Keys.Control|Keys.S)){Save.PerformClick();return true;}
            return base.ProcessCmdKey(ref m,keys);
        }
        protected override void Dispose(bool disposing) { if(disposing){tips.Dispose();if(icon.Image!=null){icon.Image.Dispose();icon.Image=null;}}base.Dispose(disposing); }
    }
}
