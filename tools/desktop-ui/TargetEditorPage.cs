using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ClaudeMcp {
    // Every custom-painted editor surface must discard its retained pixels
    // when resized, including the input hosts and the scrollable parent.
    internal class ResizePanel : Panel {
        internal ResizePanel(){DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw|ControlStyles.AllPaintingInWmPaint,true);}
        protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);Invalidate(true);}
    }
    // Keep WinForms scrolling/focus navigation, without native white chrome.
    internal sealed class EditorViewport : ResizePanel {
        [DllImport("user32.dll")] static extern bool ShowScrollBar(IntPtr window,int bar,bool show);
        [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window,int index);
        bool hiding;
        protected override CreateParams CreateParams { get { var value=base.CreateParams;value.Style&=~0x00300000;return value; } }
        void HideBars(){if(hiding||!IsHandleCreated)return;hiding=true;try{ShowScrollBar(Handle,3,false);}finally{hiding=false;}}
        protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);HideBars();}
        protected override void WndProc(ref Message m){base.WndProc(ref m);if(m.Msg==0x83||m.Msg==0x85||m.Msg==0x5||m.Msg==0x7d||m.Msg==0x47||m.Msg==0x20a)HideBars();}
        internal bool NativeBarsVisible {get{return IsHandleCreated&&(GetWindowLong(Handle,-16)&0x00300000)!=0;}}
        internal void Wheel(int delta){base.OnMouseWheel(new MouseEventArgs(MouseButtons.None,0,20,20,delta));HideBars();}
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
        internal readonly TextBox Box = new TextBox { BorderStyle=BorderStyle.None };
        internal Palette Colors = Palette.Create(false);
        internal EditorInput() { Height=44;Controls.Add(Box);Box.GotFocus+=delegate{Invalidate();};Box.LostFocus+=delegate{Invalidate();}; }
        internal void Apply(Palette colors) { Colors=colors;BackColor=colors.Surface;Box.BackColor=colors.Surface;Box.ForeColor=colors.Text;Invalidate(); }
        protected override void OnLayout(LayoutEventArgs e) { base.OnLayout(e);Box.Bounds=new Rectangle(14,(Height-Box.PreferredHeight)/2,Math.Max(1,Width-28),Box.PreferredHeight); }
        protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e);e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;PaintUi.Box(e.Graphics,new Rectangle(1,1,Width-3,Height-3),9,Colors.Surface,Box.Focused?Colors.SelectionBorder:Colors.Border); }
    }

    // A page hosted by Manager; it never owns a Form or nested message loop.
    internal sealed class TargetEditorPage : UserControl {
        internal readonly ModernButton Back = new ModernButton { Glyph="back",AccessibleName="返回云电脑列表" };
        internal readonly ModernButton Save = new ModernButton { Glyph="check",Text="保存",Primary=true,AccessibleName="保存云电脑" };
        internal readonly EditorInput NameInput = new EditorInput(), UrlInput = new EditorInput(), PasswordInput = new EditorInput();
        internal readonly CheckBox Remember = new CheckBox{Text="记住密码并自动登录（共享网页登录）",AutoSize=false};
        internal bool AutoLogin {get{return Remember.Checked;}}
        readonly Label passwordLabel=new Label();
        internal bool IsNew { get { return TargetName.Length==0; } }
        internal string Password { get { return PasswordInput.Box.Text; } }
        readonly ModernButton choose = new ModernButton { Text="选择图片…",Neutral=true }, reset = new ModernButton { Text="恢复默认" };
        readonly Label title = new Label(), nameLabel = new Label(), urlLabel = new Label(), help = new Label(), error = new Label();
        readonly PictureBox icon = new PictureBox { SizeMode=PictureBoxSizeMode.Zoom };
        readonly ResizePanel header = new ResizePanel(), footer = new ResizePanel();
        internal readonly EditorViewport viewport = new EditorViewport();
        readonly RoundedSheet sheet = new RoundedSheet();
        readonly ToolTip tips = new ToolTip();
        internal event Action BackRequested, SaveRequested;
        internal readonly string TargetName;
        readonly string initialUrl;
        readonly bool storedAutoPassword;
        internal string DisplayName { get { return NameInput.Box.Text.Trim(); } }
        internal string Url { get { return UrlInput.Box.Text.Trim(); } }
        internal string IconData;

        internal TargetEditorPage(Target target, CardPreference preference, Palette colors) {
            TargetName=target.Name;IconData=preference.icon;Dock=DockStyle.Fill;Font=new Font("Microsoft YaHei UI",11F);
            initialUrl=target.Url;storedAutoPassword=target.AutoLogin&&target.HasSavedPassword;
            DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw|ControlStyles.AllPaintingInWmPaint,true);
            NameInput.Box.MaxLength=80;NameInput.Box.Text=preference.label;
            UrlInput.Box.MaxLength=300;UrlInput.Box.Text=target.Url;
            header.Dock=DockStyle.Top;header.Height=78;header.Controls.Add(Back);header.Controls.Add(title);
            Back.Bounds=new Rectangle(28,20,40,40);title.Text=IsNew?"添加云电脑":"编辑云电脑";title.Font=new Font(Font,FontStyle.Bold);title.Bounds=new Rectangle(84,21,300,38);
            footer.Dock=DockStyle.Bottom;footer.Height=78;footer.Controls.Add(Save);
            viewport.Dock=DockStyle.Fill;viewport.AutoScroll=true;viewport.Padding=new Padding(28,16,28,24);
            sheet.Dock=DockStyle.Top;sheet.Height=654;viewport.Controls.Add(sheet);
            PasswordInput.Box.UseSystemPasswordChar=true;PasswordInput.Box.MaxLength=256;
            Remember.Checked=target.AutoLogin;
            passwordLabel.Text=target.HasSavedPassword?"密码（已加密保存；同一地址留空保留）":"密码（手动共享网页登录可留空）";
            Save.Text=IsNew?"添加":"保存";
            sheet.Controls.AddRange(new Control[]{icon,choose,reset,nameLabel,NameInput,urlLabel,UrlInput,passwordLabel,PasswordInput,Remember,help,error});
            nameLabel.Text="名称 / 备注";urlLabel.Text="云电脑地址";
            help.Text="勾选后，保存时不登录；启动连接后自动尝试一次。新登录可能让旧页面下线。取消勾选会删除共享模式保存的密码。";
            error.AutoEllipsis=true;
            Controls.Add(viewport);Controls.Add(footer);Controls.Add(header);
            tips.SetToolTip(Back,"返回列表，不保存本次修改");tips.SetToolTip(choose,"选择 PNG、JPEG 或 ICO，最多 1 MiB");tips.SetToolTip(reset,"移除自定义图标，使用默认图标");tips.SetToolTip(Save,"保存这台云电脑的修改");
            tips.SetToolTip(Remember,"仅用于共享网页登录。密码使用当前 Windows 账户加密，不会显示原密码；旧版仍沿用原有登录方式。");
            Back.Click+=delegate{if(BackRequested!=null)BackRequested();};
            Save.Click+=delegate{if(ValidateFields()&&SaveRequested!=null)SaveRequested();};
            choose.Click+=delegate{using(var picker=new OpenFileDialog{Filter="图标图片 (*.png;*.jpg;*.jpeg;*.ico)|*.png;*.jpg;*.jpeg;*.ico",CheckFileExists=true}){
                if(picker.ShowDialog(FindForm())!=DialogResult.OK)return;
                try{IconData=UiPreferences.ImportIcon(picker.FileName);RefreshIcon();ShowError("");}catch(Exception ex){ShowError(ex.Message);}
            }};
            reset.Click+=delegate{IconData="";RefreshIcon();};
            sheet.SizeChanged+=delegate{LayoutSheet();};footer.SizeChanged+=delegate{Save.Bounds=new Rectangle(Math.Max(28,footer.Width-156),18,128,42);};
            Apply(colors);RefreshIcon();LayoutSheet();
        }

        void LayoutSheet() {
            int width=Math.Max(200,sheet.ClientSize.Width-48);
            icon.Bounds=new Rectangle((sheet.ClientSize.Width-76)/2,26,76,76);
            choose.Bounds=new Rectangle((sheet.ClientSize.Width-280)/2,117,148,40);reset.Bounds=new Rectangle(choose.Right+12,117,120,40);
            nameLabel.Bounds=new Rectangle(24,185,width,27);NameInput.Bounds=new Rectangle(24,218,width,44);
            urlLabel.Bounds=new Rectangle(24,286,width,27);UrlInput.Bounds=new Rectangle(24,319,width,44);
            passwordLabel.Bounds=new Rectangle(24,380,width,27);PasswordInput.Bounds=new Rectangle(24,413,width,44);
            Remember.Bounds=new Rectangle(24,474,width,40);
            help.Bounds=new Rectangle(24,524,width,64);error.Bounds=new Rectangle(24,594,width,48);
        }
        internal bool LayoutFits { get { return NameInput.Right<=sheet.Width-20 && UrlInput.Right<=sheet.Width-20 && Save.Right<=footer.Width && Back.Right<title.Left; } }
        internal void Apply(Palette colors) {
            BackColor=header.BackColor=viewport.BackColor=footer.BackColor=colors.Page;
            sheet.BackColor=colors.Page;sheet.Colors=colors;sheet.ForeColor=colors.Text;
            title.ForeColor=nameLabel.ForeColor=urlLabel.ForeColor=passwordLabel.ForeColor=colors.Text;help.ForeColor=colors.Muted;error.ForeColor=colors.Danger;
            nameLabel.BackColor=urlLabel.BackColor=passwordLabel.BackColor=help.BackColor=error.BackColor=icon.BackColor=colors.Surface;
            Remember.BackColor=colors.Surface;Remember.ForeColor=colors.Text;
            foreach(var b in new[]{Back,Save,choose,reset}){b.Colors=colors;b.BackColor=b==choose||b==reset?colors.Surface:colors.Page;b.Invalidate();}
            NameInput.Apply(colors);UrlInput.Apply(colors);PasswordInput.Apply(colors);sheet.Invalidate();
        }
        internal void ShowError(string message) { error.Text=message; }
        internal void SetBusy(bool busy){Save.Enabled=Back.Enabled=choose.Enabled=reset.Enabled=NameInput.Enabled=UrlInput.Enabled=PasswordInput.Enabled=Remember.Enabled=!busy;}
        internal bool ValidateFields() {
            Uri parsed;
            if(DisplayName.Any(Char.IsControl)){ShowError("名称不能包含控制字符。");return false;}
            if(!Uri.TryCreate(Url,UriKind.Absolute,out parsed)||parsed.Scheme!="https"||parsed.UserInfo.Length>0||parsed.AbsolutePath!="/"||parsed.Query.Length>0||parsed.Fragment.Length>0){ShowError("请输入完整的 HTTPS 云电脑地址，不含路径或登录信息。");return false;}
            if(AutoLogin&&Password.Length==0&&(!storedAutoPassword||!String.Equals(Url.TrimEnd('/'),initialUrl.TrimEnd('/'),StringComparison.OrdinalIgnoreCase))){ShowError("请填写自动登录密码；更换地址时需要重新填写。");return false;}
            ShowError("");return true;
        }
        void RefreshIcon() {
            var previous=icon.Image;
            if(IconData.Length>0)icon.Image=UiPreferences.DecodeIcon(IconData);
            else {var bmp=new Bitmap(76,76);using(var g=Graphics.FromImage(bmp)){g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;PaintUi.Box(g,new Rectangle(1,1,73,73),15,sheet.Colors.Subtle,sheet.Colors.Border);PaintUi.Icon(g,"monitor",new Rectangle(21,21,34,34),sheet.Colors.Blue);}icon.Image=bmp;}
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
