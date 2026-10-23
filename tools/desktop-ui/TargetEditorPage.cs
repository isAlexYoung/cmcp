using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeMcp {
    internal sealed class RoundedSheet : Panel {
        internal Palette Colors = Palette.Create(false);
        internal RoundedSheet() { DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            PaintUi.Box(e.Graphics, new Rectangle(1,1,Width-3,Height-3),15,Colors.Surface,Colors.Border);
        }
    }

    internal sealed class EditorInput : Panel {
        internal readonly TextBox Box = new TextBox { BorderStyle=BorderStyle.None };
        internal Palette Colors = Palette.Create(false);
        internal EditorInput() { DoubleBuffered=true;Height=44;Controls.Add(Box); }
        internal void Apply(Palette colors) { Colors=colors;BackColor=colors.Surface;Box.BackColor=colors.Surface;Box.ForeColor=colors.Text;Invalidate(); }
        protected override void OnLayout(LayoutEventArgs e) { base.OnLayout(e);Box.Bounds=new Rectangle(14,(Height-Box.PreferredHeight)/2,Math.Max(1,Width-28),Box.PreferredHeight); }
        protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e);e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;PaintUi.Box(e.Graphics,new Rectangle(1,1,Width-3,Height-3),9,Colors.Surface,Box.Focused?Colors.SelectionBorder:Colors.Border); }
    }

    // A page hosted by Manager; it never owns a Form or nested message loop.
    internal sealed class TargetEditorPage : UserControl {
        internal readonly ModernButton Back = new ModernButton { Glyph="back",AccessibleName="返回云电脑列表" };
        internal readonly ModernButton Save = new ModernButton { Glyph="check",Text="保存",Primary=true,AccessibleName="保存云电脑" };
        internal readonly EditorInput NameInput = new EditorInput(), UrlInput = new EditorInput();
        readonly ModernButton choose = new ModernButton { Text="选择图片…",Neutral=true }, reset = new ModernButton { Text="恢复默认" };
        readonly Label title = new Label(), nameLabel = new Label(), urlLabel = new Label(), help = new Label(), error = new Label();
        readonly PictureBox icon = new PictureBox { SizeMode=PictureBoxSizeMode.Zoom };
        readonly Panel header = new Panel(), viewport = new Panel(), footer = new Panel();
        readonly RoundedSheet sheet = new RoundedSheet();
        readonly ToolTip tips = new ToolTip();
        internal event Action BackRequested, SaveRequested;
        internal readonly string TargetName;
        internal string DisplayName { get { return NameInput.Box.Text.Trim(); } }
        internal string Url { get { return UrlInput.Box.Text.Trim(); } }
        internal string IconData;

        internal TargetEditorPage(Target target, CardPreference preference, Palette colors) {
            TargetName=target.Name;IconData=preference.icon;Dock=DockStyle.Fill;Font=new Font("Microsoft YaHei UI",11F);
            NameInput.Box.MaxLength=80;NameInput.Box.Text=preference.label;
            UrlInput.Box.MaxLength=300;UrlInput.Box.Text=target.Url;
            header.Dock=DockStyle.Top;header.Height=78;header.Controls.Add(Back);header.Controls.Add(title);
            Back.Bounds=new Rectangle(28,20,40,40);title.Text="编辑云电脑";title.Font=new Font(Font,FontStyle.Bold);title.Bounds=new Rectangle(84,21,300,38);
            footer.Dock=DockStyle.Bottom;footer.Height=78;footer.Controls.Add(Save);
            viewport.Dock=DockStyle.Fill;viewport.AutoScroll=true;viewport.Padding=new Padding(28,16,28,24);
            sheet.Dock=DockStyle.Top;sheet.Height=460;viewport.Controls.Add(sheet);
            sheet.Controls.AddRange(new Control[]{icon,choose,reset,nameLabel,NameInput,urlLabel,UrlInput,help,error});
            nameLabel.Text="名称 / 备注";urlLabel.Text="云电脑地址";
            help.Text="修改地址前请先停止此连接；保存后沿用原有地址验证向导。";
            error.AutoEllipsis=true;
            Controls.Add(viewport);Controls.Add(footer);Controls.Add(header);
            tips.SetToolTip(Back,"返回列表，不保存本次修改");tips.SetToolTip(choose,"选择 PNG、JPEG 或 ICO，最多 1 MiB");tips.SetToolTip(reset,"移除自定义图标，使用默认图标");tips.SetToolTip(Save,"保存这台云电脑的修改");
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
            help.Bounds=new Rectangle(24,376,width,26);error.Bounds=new Rectangle(24,409,width,38);
        }
        internal bool LayoutFits { get { return NameInput.Right<=sheet.Width-20 && UrlInput.Right<=sheet.Width-20 && Save.Right<=footer.Width && Back.Right<title.Left; } }
        internal void Apply(Palette colors) {
            BackColor=header.BackColor=viewport.BackColor=footer.BackColor=colors.Page;
            sheet.BackColor=colors.Page;sheet.Colors=colors;sheet.ForeColor=colors.Text;
            title.ForeColor=nameLabel.ForeColor=urlLabel.ForeColor=colors.Text;help.ForeColor=colors.Muted;error.ForeColor=colors.Danger;
            nameLabel.BackColor=urlLabel.BackColor=help.BackColor=error.BackColor=icon.BackColor=colors.Surface;
            foreach(var b in new[]{Back,Save,choose,reset}){b.Colors=colors;b.BackColor=b==choose||b==reset?colors.Surface:colors.Page;b.Invalidate();}
            NameInput.Apply(colors);UrlInput.Apply(colors);sheet.Invalidate();
        }
        internal void ShowError(string message) { error.Text=message; }
        internal bool ValidateFields() {
            Uri parsed;
            if(DisplayName.Any(Char.IsControl)){ShowError("名称不能包含控制字符。");return false;}
            if(!Uri.TryCreate(Url,UriKind.Absolute,out parsed)||parsed.Scheme!="https"||parsed.UserInfo.Length>0||parsed.AbsolutePath!="/"||parsed.Query.Length>0||parsed.Fragment.Length>0){ShowError("请输入完整的 HTTPS 云电脑地址，不含路径或登录信息。");return false;}
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
