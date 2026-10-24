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
        static readonly Dictionary<string,string> Stages=new Dictionary<string,string>{{"installed","正在检查当前安装"},{"release","正在获取更新信息"},{"download","正在下载更新"},{"checksum","正在校验下载文件"},{"extract","正在解压更新"},{"verify","正在校验安装包"},{"restart","更新已准备，正在重新启动…"},{"failed","更新未完成"}};
        internal string Title {get{string value;return L.Text(Stages.TryGetValue(Stage??"",out value)?value:"正在准备更新");}}
        internal string Detail {get{
            if(Stage=="failed")return L.Text(Failure(Code));
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
