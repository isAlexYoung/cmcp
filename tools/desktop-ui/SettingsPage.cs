using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class SettingsPage : UserControl {
        internal readonly EditorViewport Viewport=new EditorViewport{Dock=DockStyle.Fill,AutoScroll=true,Padding=new Padding(28,12,28,24)};
        internal readonly ModernButton Back=new ModernButton{Glyph="back",AccessibleName="返回"};
        readonly ModernButton general=new ModernButton{Text="通用",CenterText=true},about=new ModernButton{Text="关于",CenterText=true};
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
        internal void ShowAbout(){isAbout=true;Build();}
        internal event Action BackRequested;
        internal SettingsPage(AppSettings values,Palette palette,Action<AppSettings> changed,Action<string> invoked){
            Dock=DockStyle.Fill;Font=new Font("Microsoft YaHei UI",11F);settings=values;colors=palette;change=changed;action=invoked;
            header.Controls.AddRange(new Control[]{Back,title,tabs});tabs.Controls.AddRange(new Control[]{general,about});Viewport.Controls.Add(sheet);Controls.Add(Viewport);Controls.Add(header);
            Back.Bounds=new Rectangle(28,20,40,40);title.Bounds=new Rectangle(84,20,300,40);title.Font=new Font(Font,FontStyle.Bold);
            Back.Click+=delegate{if(BackRequested!=null)BackRequested();};general.Click+=delegate{isAbout=false;Build();};about.Click+=delegate{isAbout=true;Build();};
            header.SizeChanged+=delegate{tabs.Bounds=new Rectangle(28,80,header.Width-56,48);general.Bounds=new Rectangle(5,5,(tabs.Width-10)/2,38);about.Bounds=new Rectangle(general.Right,5,general.Width,38);};
            sheet.SizeChanged+=delegate{LayoutRows();};Build();
        }
        ModernButton Button(string text,int y,int x,int width,Action click,bool selected){return Button(text,y,x,width,click,()=>selected);}
        ModernButton Button(string text,int y,int x,int width,Action click,Func<bool> selected){var b=new ModernButton{Text=text,Bounds=new Rectangle(x,y,width,40),Anchor=AnchorStyles.Left|AnchorStyles.Top};b.Click+=delegate{click();};sheet.Controls.Add(b);refresh.Add(delegate{b.Primary=selected();b.Neutral=!b.Primary;b.Invalidate();});return b;}
        void Label(string text,int y,bool muted){var label=new Label{Text=L.Text(text),Bounds=new Rectangle(24,y,100,muted?56:30),Tag="wide",ForeColor=muted?colors.Muted:colors.Text,BackColor=colors.Surface,AutoEllipsis=false};sheet.Controls.Add(label);refresh.Add(delegate{label.Text=L.Text(text);});}
        void RefreshControls(){title.Text=L.Text("设置");foreach(var update in refresh)update();Apply(colors);}
        void Commit(Action<AppSettings> edit){var next=settings.Copy();edit(next);try{change(next);settings.language=next.language;settings.theme=next.theme;settings.autoStart=next.autoStart;settings.closeToTray=next.closeToTray;}catch{RefreshControls();SetFeedback("设置未能保存，请检查本机文件和注册表权限。",true);return;}RefreshControls();SetFeedback("设置已保存。",false);}
        void Build(){
            refresh.Clear();
            sheet.Controls.Remove(feedback);sheet.Controls.Remove(updateView);foreach(Control c in sheet.Controls.Cast<Control>().ToArray())c.Dispose();sheet.Controls.Clear();updateLabel=null;
            title.Text=L.Text("设置");general.Primary=!isAbout;about.Primary=isAbout;
            if(!isAbout){
                Label("界面语言",24,false);Label("切换后立即生效，保存到当前 Windows 账户。",59,true);
                Button("简体中文",110,24,155,delegate{Commit(s=>s.language="zh-CN");},()=>settings.language=="zh-CN");Button("English",110,191,155,delegate{Commit(s=>s.language="en");},()=>settings.language=="en");
                Label("外观主题",182,false);
                Button("浅色",223,24,148,delegate{Commit(s=>s.theme="light");},()=>settings.theme=="light");Button("深色",223,184,148,delegate{Commit(s=>s.theme="dark");},()=>settings.theme=="dark");Button("跟随系统",223,344,148,delegate{Commit(s=>s.theme="system");},()=>settings.theme=="system");
                Label("窗口行为",298,false);
                var startup=new CheckBox{Text=L.Text("开机自启"),Checked=settings.autoStart,Bounds=new Rectangle(24,340,480,36),ForeColor=colors.Text,BackColor=colors.Surface};startup.Click+=delegate{Commit(s=>s.autoStart=startup.Checked);};sheet.Controls.Add(startup);
                refresh.Add(delegate{startup.Checked=settings.autoStart;startup.Text=L.Text("开机自启");});
                Label("登录 Windows 后启动到系统托盘；只恢复原来已启用的连接。",382,true);
                Label("关闭窗口时",458,false);
                Button("直接退出程序",500,24,240,delegate{Commit(s=>s.closeToTray=false);},()=>!settings.closeToTray);Button("隐藏到系统托盘",500,276,240,delegate{Commit(s=>s.closeToTray=true);},()=>settings.closeToTray);
                Label("直接退出会断开全部云电脑；隐藏到系统托盘会保留已连接的云电脑。",558,true);
                Label("桌面快捷方式",650,false);Label("为当前程序创建 CMCP 桌面快捷方式。",690,true);Button("创建快捷方式",748,24,240,delegate{action("shortcut");},false);
                sheet.Height=890;
            }else{
                Label("CMCP",24,false);Label(L.Text("版本")+"  "+System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3)+"  ·  Windows x64",66,true);
                updateLabel=new Label{Text=L.Text(UpdateStatus),Bounds=new Rectangle(24,128,100,30),Tag="wide"};sheet.Controls.Add(updateLabel);
                updateView.Bounds=new Rectangle(24,168,100,128);updateView.Tag="wide";sheet.Controls.Add(updateView);updateView.Set(updateProgress);
                Button("检查更新",310,24,220,delegate{action("update");},true);Button("前往发布页",366,24,220,delegate{action("releases");},false);
                Button("程序文件夹",456,24,220,delegate{action("program");},false);Button("日志文件夹",512,24,220,delegate{action("logs");},false);sheet.Height=675;
            }
            feedback.Bounds=new Rectangle(24,sheet.Height-72,100,60);feedback.Tag="wide";sheet.Controls.Add(feedback);RefreshControls();LayoutRows();
        }
        void LayoutRows(){foreach(Control c in sheet.Controls)if((string)c.Tag=="wide")c.Width=Math.Max(100,sheet.ClientSize.Width-48);}
        internal void SetFeedback(string message,bool error){feedback.Text=L.Message(message);feedback.ForeColor=error?colors.Danger:colors.Success;if(error)Viewport.ScrollControlIntoView(feedback);}
        internal void SetUpdateStatus(string value){UpdateStatus=value;if(updateLabel!=null)updateLabel.Text=L.Text(value);}
        internal void SetUpdateProgress(UpdateProgress value){updateProgress=value;updateView.Set(value);updateView.Apply(colors);if(value!=null&&updateLabel!=null)updateLabel.Text=value.Title;}
        internal void Apply(Palette palette){colors=palette;BackColor=header.BackColor=Viewport.BackColor=colors.Page;sheet.BackColor=tabs.BackColor=colors.Page;sheet.Colors=tabs.Colors=colors;title.ForeColor=colors.Text;
            foreach(Control c in sheet.Controls){var b=c as ModernButton;if(b!=null){b.Colors=colors;b.BackColor=colors.Surface;b.Invalidate();}else{c.BackColor=colors.Surface;if(c!=feedback)c.ForeColor=c is Label&&c.Height>30?colors.Muted:colors.Text;}}
            foreach(var b in new[]{Back,general,about}){b.Colors=colors;b.BackColor=colors.Page;b.Invalidate();}Invalidate(true);
            updateView.Apply(colors);
        }
        protected override bool ProcessCmdKey(ref Message m,Keys keys){if(keys==Keys.Escape){if(BackRequested!=null)BackRequested();return true;}return base.ProcessCmdKey(ref m,keys);}
        protected override void Dispose(bool disposing){if(disposing)updateView.Dispose();base.Dispose(disposing);}
    }
}
