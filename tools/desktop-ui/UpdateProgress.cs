using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class UpdateProgress {
        internal string Stage,Code="",Unit="bytes";
        internal long Received,Total;
        internal bool Visible=true;
        internal int Percent {get{return Total>0?(int)Math.Min(100,100m*Received/Total):-1;}}
        // Stage ranges estimate overall work; Detail always retains the measured stage counters.
        internal int OverallPercent {get{
            int start=0,end=5;
            switch(Stage){case "release":start=5;end=10;break;case "download":start=10;end=80;break;case "checksum":start=80;end=85;break;case "extract":start=85;end=95;break;case "verify":start=95;end=99;break;case "ready":case "restart":return 100;case "failed":return -1;}
            return start+(int)((end-start)*Math.Max(0,Percent)/100d);
        }}
        static readonly Dictionary<string,string> Stages=new Dictionary<string,string>{{"installed","正在检查当前安装"},{"release","正在获取更新信息"},{"download","正在下载更新"},{"checksum","正在校验下载文件"},{"extract","正在解压更新"},{"verify","正在校验安装包"},{"ready","更新已下载并校验，等待安装确认"},{"restart","更新已准备，正在重新启动…"},{"failed","更新未完成"}};
        internal string Title {get{string value;return L.Text(Stages.TryGetValue(Stage??"",out value)?value:"正在准备更新");}}
        internal string Detail {get{
            if(Stage=="failed")return L.Text(Failure(Code));
            if(Stage=="ready")return L.Text("当前版本仍在运行；点击“安装更新”后确认安装。");
            if(Total>0)return Unit=="files"?Received+" / "+Total+" "+L.Text("个文件")+" · "+Percent+"%":String.Format(System.Globalization.CultureInfo.InvariantCulture,"{0:0.0} / {1:0.0} MB · {2}%",Received/1048576d,Total/1048576d,Percent);
            return L.Text(Stage=="restart"?"程序重启后完成更新，原安装会保留备份。":"请稍候；验证完成前不会替换当前安装。");
        }}
        internal static string Failure(string code){switch(code){
            case "network":return "下载连接失败，请检查网络或代理后点击更新重试。";
            case "timeout":return "下载超时，请检查网络后点击更新重试。";
            case "tls":return "无法验证下载服务器的安全连接，请检查系统时间或代理。";
            case "installation":return "当前安装文件缺失、已修改或含额外文件，请使用完整安装包。";
            case "permissions":return "无法写入更新目录，请检查文件夹权限和磁盘空间。";
            case "release":return "没有找到有效的 Windows 更新包，请前往发布页检查。";
            case "checksum":return "下载文件校验失败，当前安装未替换，请点击更新重新下载。";
            case "package":return "安装包内容不完整或校验失败，当前安装未替换，请重新下载。";
            case "identity":return "运行中的程序与安装目录不匹配，请从安装文件夹重新启动。";
            default:return "更新准备失败，当前安装未替换；可重试或在设置中打开日志文件夹。";
        }}
        internal static UpdateProgress Read(IDictionary<string,object> data){
            if(Convert.ToString(LocalState.Get(data,"type"))!="progress")return null;
            string stage=Convert.ToString(LocalState.Get(data,"stage")),unit=Convert.ToString(LocalState.Get(data,"unit"));
            long received,total;
            if(!Stages.ContainsKey(stage)||stage=="failed"||stage=="restart"||!Int64.TryParse(Convert.ToString(LocalState.Get(data,"received")),out received)||!Int64.TryParse(Convert.ToString(LocalState.Get(data,"total")),out total)||received<0||total<0||received>2147483648L||total>2147483648L||(total>0&&received>total)||(unit!="bytes"&&unit!="files"))throw new InvalidDataException();
            return new UpdateProgress{Stage=stage,Received=received,Total=total,Unit=unit};
        }
    }
    internal sealed class UpdateProgressRing : Control {
        internal UpdateProgress Value;
        internal int OverallPercent {get;private set;}
        internal string Hint {get;private set;}
        internal bool Animating {get{return clock!=null;}}
        readonly LocalToolTip tips=new LocalToolTip();
        readonly System.Diagnostics.Stopwatch elapsed=new System.Diagnostics.Stopwatch();
        Palette colors=Palette.Create(false);
        FrameClock clock;
        double from,shown;
        string previousStage;
        internal UpdateProgressRing(){
            Size=new Size(40,40);Visible=false;TabStop=true;AccessibleRole=AccessibleRole.ProgressBar;
            SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw|ControlStyles.Selectable,true);
            L.Changed+=RefreshHint;
        }
        internal void Set(UpdateProgress value){
            bool reset=Value==null||!Value.Visible||value==null||!value.Visible||(previousStage=="failed"&&value.Stage!="failed");
            StopAnimation();Value=value;
            if(reset){OverallPercent=0;shown=0;}
            bool active=value!=null&&value.Visible;Visible=active;if(active&&Parent!=null&&Parent.IsHandleCreated)CreateControl();
            if(active&&value.Stage!="failed")OverallPercent=Math.Max(OverallPercent,value.OverallPercent);
            previousStage=value==null?null:value.Stage;
            if(Visible&&Motion.Enabled&&IsHandleCreated&&Math.Abs(shown-OverallPercent)>0.01){from=shown;elapsed.Restart();clock=new FrameClock(this,Frame);clock.Start();}else shown=OverallPercent;
            RefreshHint();Invalidate();
        }
        void RefreshHint(){
            Hint=Value==null?"":Value.Title+"\n"+(Value.Stage=="failed"?"":L.Text("总体进度（估算）")+"："+OverallPercent+"%\n")+Value.Detail;
            AccessibleName=Value==null?"":Value.Title;AccessibleDescription=Hint;tips.SetToolTip(this,Hint,true);
        }
        void Frame(){double t=elapsed.Elapsed.TotalMilliseconds/180;shown=from+(OverallPercent-from)*Motion.EaseOut(t);if(t>=1){shown=OverallPercent;StopAnimation();}Invalidate();}
        void StopAnimation(){if(clock!=null){clock.Stop();clock=null;}elapsed.Stop();}
        internal void Apply(Palette palette){colors=palette;BackColor=palette.Surface;tips.Apply(palette);Invalidate();}
        protected override void OnGotFocus(EventArgs e){base.OnGotFocus(e);tips.ShowForFocus(this);Invalidate();}
        protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);tips.Hide();Invalidate();}
        protected override void OnVisibleChanged(EventArgs e){base.OnVisibleChanged(e);if(!Visible){StopAnimation();shown=OverallPercent;tips.Hide();}}
        protected override void OnPaint(PaintEventArgs e){
            base.OnPaint(e);if(Value==null)return;
            var g=e.Graphics;g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var r=new RectangleF(8,8,Width-16,Height-16);
            using(var track=new Pen(colors.Border,3))g.DrawEllipse(track,r);
            using(var progress=new Pen(Value.Stage=="failed"?colors.Danger:colors.Blue,3)){progress.StartCap=progress.EndCap=System.Drawing.Drawing2D.LineCap.Round;float sweep=(float)(Math.Max(0,Math.Min(100,shown))*3.6);if(sweep>0)g.DrawArc(progress,r,-90,sweep);}
            if(Value.Stage=="failed")TextRenderer.DrawText(g,"!",Font,ClientRectangle,colors.Danger,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix);
            if(Focused&&ShowFocusCues)using(var p=new Pen(colors.SelectionBorder))using(var path=PaintUi.Round(new Rectangle(2,2,Width-5,Height-5),8))g.DrawPath(p,path);
        }
        protected override void Dispose(bool disposing){if(disposing){StopAnimation();tips.Dispose();L.Changed-=RefreshHint;}base.Dispose(disposing);}
    }
    internal sealed class UpdateProgressView : Control {
        internal UpdateProgress Value;
        Palette colors=Palette.Create(false);
        readonly Timer animation=new Timer{Interval=60};
        int offset;
        internal UpdateProgressView(){Height=128;DoubleBuffered=true;SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.ResizeRedraw,true);AccessibleRole=AccessibleRole.ProgressBar;animation.Tick+=delegate{offset=(offset+8)%Math.Max(1,Width);Invalidate();};}
        internal void Set(UpdateProgress value){Value=value;Visible=value!=null&&value.Visible;AccessibleName=value==null?"":value.Title+" "+value.Detail;if(Visible&&value.Percent<0&&value.Stage!="failed"&&value.Stage!="restart")animation.Start();else animation.Stop();Invalidate();}
        internal void Apply(Palette palette){colors=palette;BackColor=colors.Page;Invalidate();}
        protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Value==null)return;
            var box=new Rectangle(0,0,Math.Max(1,Width-1),Math.Max(1,Height-15));
            PaintUi.Box(e.Graphics,box,12,colors.Surface,colors.Border);
            var foreground=Value.Stage=="failed"?colors.Danger:colors.Text;
            using(var bold=new Font(Font,FontStyle.Bold))TextRenderer.DrawText(e.Graphics,Value.Title,bold,new Rectangle(16,12,Width-32,26),foreground,TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(e.Graphics,Value.Detail,Font,new Rectangle(16,42,Width-32,42),colors.Muted,TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix);
            if(Value.Stage!="failed"){
                var track=new Rectangle(16,Height-34,Math.Max(1,Width-32),6);
                using(var brush=new SolidBrush(colors.Border))e.Graphics.FillRectangle(brush,track);
                var bar=track;bar.Width=Value.Percent<0?Math.Max(12,track.Width/4):Math.Max(0,track.Width*Value.Percent/100);
                if(Value.Percent<0)bar.X=track.X+offset%Math.Max(1,track.Width-bar.Width+1);
                using(var brush=new SolidBrush(colors.Blue))e.Graphics.FillRectangle(brush,bar);
            }
        }
        protected override void Dispose(bool disposing){if(disposing){animation.Stop();animation.Dispose();}base.Dispose(disposing);}
    }
}
