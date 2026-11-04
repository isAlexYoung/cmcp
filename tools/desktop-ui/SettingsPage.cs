using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class SettingsPage : UserControl {
        internal readonly EditorViewport Viewport=new EditorViewport{Dock=DockStyle.Fill,AutoScroll=true,Padding=new Padding(28,12,28,24)};
        internal readonly ModernButton Back=new ModernButton{Glyph="back",AccessibleName="返回"};
        internal readonly ModernButton GeneralTab=new ModernButton{Text="通用",CenterText=true,Segment=true},AboutTab=new ModernButton{Text="关于",CenterText=true,Segment=true};
        readonly RoundedSheet tabs=new RoundedSheet();
        readonly ResizePanel header=new ResizePanel{Dock=DockStyle.Top,Height=138};
        readonly Label title=new Label{Text="设置"};
        readonly Label feedback=new Label{AutoSize=false};
        readonly RoundedSheet sheet=new RoundedSheet{Dock=DockStyle.Top};
        readonly AppSettings settings;
        readonly Action<AppSettings> change;
        readonly Action<string> action;
        readonly List<Action> refresh=new List<Action>();
        Palette colors;
        bool isAbout;
        internal string UpdateStatus="检查更新";
        readonly UpdateProgressView updateView=new UpdateProgressView();
        Label updateLabel;
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
            header.Controls.AddRange(new Control[]{Back,title,tabs});tabs.Controls.AddRange(new Control[]{GeneralTab,AboutTab});Viewport.Controls.Add(sheet);Controls.Add(Viewport);Controls.Add(header);
            Back.Bounds=new Rectangle(28,20,40,40);title.Bounds=new Rectangle(84,20,300,40);title.Font=new Font(Font,FontStyle.Bold);
            Back.Click+=delegate{if(BackRequested!=null)BackRequested();};GeneralTab.Click+=delegate{ShowTab(false);};AboutTab.Click+=delegate{ShowTab(true);};
            header.SizeChanged+=delegate{tabs.Bounds=new Rectangle(28,80,header.Width-56,48);GeneralTab.Bounds=new Rectangle(5,5,(tabs.Width-10)/2,38);AboutTab.Bounds=new Rectangle(GeneralTab.Right,5,GeneralTab.Width,38);};
            sheet.SizeChanged+=delegate{LayoutRows();};Build();
        }
        ModernButton Button(string text,int y,int x,int width,Action click,bool selected){return Button(text,y,x,width,click,()=>selected);}
        ModernButton Button(string text,int y,int x,int width,Action click,Func<bool> selected){var b=new ModernButton{Text=text,Bounds=new Rectangle(x,y,width,40),Anchor=AnchorStyles.Left|AnchorStyles.Top};b.Click+=delegate{click();};sheet.Controls.Add(b);refresh.Add(delegate{b.Primary=selected();b.Neutral=!b.Primary;b.Invalidate();});return b;}
        RoundedSheet Track(int y,int width){var track=new RoundedSheet{Bounds=new Rectangle(24,y,width,48)};sheet.Controls.Add(track);return track;}
        void Option(RoundedSheet track,int index,int count,string text,Action<AppSettings> edit,Func<bool> chosen){
            int width=(track.Width-10)/count;
            var b=new ModernButton{Text=text,CenterText=true,Segment=true,Bounds=new Rectangle(5+index*width,5,width,38)};
            b.Click+=delegate{if(!chosen())Commit(edit);};
            track.Controls.Add(b);refresh.Add(delegate{b.Selected=chosen();b.Invalidate();});
        }
        void Label(string text,int y,bool muted){var label=new Label{Text=L.Text(text),Bounds=new Rectangle(24,y,100,muted?56:30),Tag="wide",ForeColor=muted?colors.Muted:colors.Text,BackColor=colors.Surface,AutoEllipsis=false};sheet.Controls.Add(label);refresh.Add(delegate{label.Text=L.Text(text);});}
        void RefreshControls(){title.Text=L.Text("设置");foreach(var update in refresh)update();Apply(colors);}
        void Commit(Action<AppSettings> edit){var next=settings.Copy();edit(next);try{change(next);settings.language=next.language;settings.theme=next.theme;settings.autoStart=next.autoStart;settings.closeToTray=next.closeToTray;}catch{RefreshControls();SetFeedback("设置未能保存，请检查本机文件和注册表权限。",true);return;}RefreshControls();SetFeedback("设置已保存。",false);}
        void Build(){
            refresh.Clear();
            sheet.Controls.Remove(feedback);sheet.Controls.Remove(updateView);foreach(Control c in sheet.Controls.Cast<Control>().ToArray())c.Dispose();sheet.Controls.Clear();updateLabel=null;
            title.Text=L.Text("设置");GeneralTab.Selected=!isAbout;AboutTab.Selected=isAbout;
            if(!isAbout){
                Label("界面语言",24,false);Label("切换后立即生效，保存到当前 Windows 账户。",59,true);
                var language=Track(118,340);
                Option(language,0,2,"简体中文",s=>s.language="zh-CN",()=>settings.language=="zh-CN");Option(language,1,2,"English",s=>s.language="en",()=>settings.language=="en");
                Label("外观主题",186,false);
                var theme=Track(224,480);
                Option(theme,0,3,"浅色",s=>s.theme="light",()=>settings.theme=="light");Option(theme,1,3,"深色",s=>s.theme="dark",()=>settings.theme=="dark");Option(theme,2,3,"跟随系统",s=>s.theme="system",()=>settings.theme=="system");
                Label("窗口行为",292,false);
                var startup=new ToggleSwitch{Text=L.Text("开机自启"),Checked=settings.autoStart,Colors=colors,Bounds=new Rectangle(24,328,480,36),ForeColor=colors.Text,BackColor=colors.Surface};startup.Click+=delegate{Commit(s=>s.autoStart=startup.Checked);};sheet.Controls.Add(startup);
                refresh.Add(delegate{startup.Checked=settings.autoStart;startup.Text=L.Text("开机自启");});
                Label("登录 Windows 后启动到系统托盘；只恢复原来已启用的连接。",368,true);
                Label("关闭窗口时",432,false);
                var closing=Track(468,500);
                Option(closing,0,2,"直接退出程序",s=>s.closeToTray=false,()=>!settings.closeToTray);Option(closing,1,2,"隐藏到系统托盘",s=>s.closeToTray=true,()=>settings.closeToTray);
                Label("直接退出会断开全部云电脑；隐藏到系统托盘会保留已连接的云电脑。",524,true);
                Label("桌面快捷方式",592,false);Label("为当前程序创建 CMCP 桌面快捷方式。",627,true);Button("创建快捷方式",686,24,240,delegate{action("shortcut");},false);
                sheet.Height=810;
            }else{
                Label("CMCP",24,false);Label(L.Text("版本")+"  "+System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3)+"  ·  Windows x64",66,true);
                updateLabel=new Label{Text=L.Text(UpdateStatus),Bounds=new Rectangle(24,128,100,30),Tag="wide"};sheet.Controls.Add(updateLabel);
                updateView.Bounds=new Rectangle(24,168,100,128);updateView.Tag="wide";sheet.Controls.Add(updateView);updateView.Set(updateProgress);
                Button("检查更新",310,24,220,delegate{action("update");},true);Button("前往发布页",366,24,220,delegate{action("releases");},false);
                Button("程序文件夹",456,24,220,delegate{action("program");},false);Button("日志文件夹",512,24,220,delegate{action("logs");},false);
                Label("卸载 CMCP",586,false);Label(Installation.Uninstaller(AppDomain.CurrentDomain.BaseDirectory)!=null?"断开全部连接，移除云电脑上的 Claude 配置，并删除本机保存的地址、密码、设置和程序文件。":"断开全部连接，移除云电脑上的 Claude 配置，并删除本机保存的地址、密码和设置。程序文件夹和桌面快捷方式需要之后手动删除。",624,true);Button("卸载 CMCP",690,24,220,delegate{action("uninstall");},false);sheet.Height=850;
            }
            feedback.Bounds=new Rectangle(24,sheet.Height-72,100,60);feedback.Tag="wide";sheet.Controls.Add(feedback);RefreshControls();LayoutRows();
        }
        void LayoutRows(){foreach(Control c in sheet.Controls)if((string)c.Tag=="wide")c.Width=Math.Max(100,sheet.ClientSize.Width-48);}
        internal void SetFeedback(string message,bool error){feedback.Text=L.Message(message);feedback.ForeColor=error?colors.Danger:colors.Success;if(error)Viewport.ScrollControlIntoView(feedback);}
        internal void SetUpdateStatus(string value){UpdateStatus=value;if(updateLabel!=null)updateLabel.Text=L.Text(value);}
        internal void SetUpdateProgress(UpdateProgress value){updateProgress=value;updateView.Set(value);updateView.Apply(colors);if(value!=null&&updateLabel!=null)updateLabel.Text=value.Title;}
        internal void Apply(Palette palette){colors=palette;BackColor=header.BackColor=Viewport.BackColor=colors.Page;sheet.BackColor=tabs.BackColor=colors.Page;sheet.Colors=tabs.Colors=colors;title.ForeColor=colors.Text;
            foreach(Control c in sheet.Controls){
                var b=c as ModernButton;var track=c as RoundedSheet;var toggle=c as ToggleSwitch;
                if(b!=null){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}
                else if(track!=null){track.Colors=colors;track.BackColor=colors.Surface;foreach(var option in track.Controls.OfType<ModernButton>()){option.Colors=colors;option.BackColor=colors.Surface;option.Invalidate();}}
                else{c.BackColor=colors.Surface;if(c!=feedback)c.ForeColor=c is Label&&c.Height>30?colors.Muted:colors.Text;if(toggle!=null)toggle.Colors=colors;}
            }
            Back.Colors=colors;Back.BackColor=colors.Page;Back.Invalidate();
            foreach(var tab in new[]{GeneralTab,AboutTab}){tab.Colors=colors;tab.BackColor=colors.Surface;tab.Invalidate();}Invalidate(true);
            updateView.Apply(colors);
        }
        protected override bool ProcessCmdKey(ref Message m,Keys keys){if(keys==Keys.Escape){if(BackRequested!=null)BackRequested();return true;}return base.ProcessCmdKey(ref m,keys);}
        protected override void Dispose(bool disposing){if(disposing)updateView.Dispose();base.Dispose(disposing);}
    }
    // Still a CheckBox, so keyboard use, accessibility and wheel handling stay as they were.
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
            int top=(Height-TrackHeight)/2;var fill=Motion.Mix(Colors.Border,Colors.Blue,Level);
            PaintUi.Box(g,new Rectangle(1,top,TrackWidth,TrackHeight),TrackHeight/2,fill,fill);
            int inset=(TrackHeight-Thumb)/2,x=1+inset+(int)Math.Round((TrackWidth-Thumb-2*inset)*Level);
            using(var b=new SolidBrush(Color.White))g.FillEllipse(b,x,top+inset,Thumb,Thumb);
            TextRenderer.DrawText(g,Text,Font,new Rectangle(TrackWidth+12,0,Math.Max(1,Width-TrackWidth-12),Height),ForeColor,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);
            if(Focused&&ShowFocusCues)using(var path=PaintUi.Round(new Rectangle(0,top-2,TrackWidth+2,TrackHeight+3),TrackHeight/2+1))using(var p=new Pen(Colors.SelectionBorder))g.DrawPath(p,path);
        }
        protected override void Dispose(bool disposing){if(disposing){motion.Stop();motion.Dispose();}base.Dispose(disposing);}
    }
}
