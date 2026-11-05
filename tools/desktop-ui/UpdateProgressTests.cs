using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace CMCP {
    internal static class UpdateProgressTests {
        internal static void Run(string directory,Action<bool,string> check){
            RepaintTests(directory,check);
            var packet=new Dictionary<string,object>{{"type","progress"},{"stage","download"},{"received",30},{"total",100},{"unit","bytes"},{"message","DO-NOT-DISPLAY"}};
            var value=UpdateProgress.Read(packet);check(value.Percent==30&&!value.Detail.Contains("DO-NOT-DISPLAY"),"update progress shows measured bytes and ignores untrusted message text");
            packet["received"]=101;bool rejected=false;try{UpdateProgress.Read(packet);}catch(InvalidDataException){rejected=true;}check(rejected,"invalid progress counters cannot overflow or report a false completion");
            using(var form=new Manager(true)){
                form.Show();form.SetUpdateProgress(value);Application.DoEvents();check(form.UpdateView.Visible&&form.UpdateView.Value.Percent==30&&form.UpdateView.Parent==form.toolbar&&form.UpdateView.Left>form.toolbar.Settings.Right&&form.OwnedForms.Length==0,"update progress appears as a ring beside Settings instead of above the cards");
                foreach(bool dark in new[]{false,true}){form.SetTheme(dark);form.ClientSize=new Size(660,500);Application.DoEvents();using(var image=new Bitmap(form.Width,form.Height))form.DrawToBitmap(image,new Rectangle(Point.Empty,image.Size));check(form.UpdateView.Visible&&form.UpdateView.Width<=form.ClientSize.Width,"update progress remains visible at narrow width in theme "+dark);}
                int downloaded=form.UpdateView.OverallPercent;form.SetUpdateProgress(new UpdateProgress{Stage="checksum"});
                check(form.UpdateView.OverallPercent>downloaded&&form.UpdateView.Hint.Contains(L.Text("正在校验下载文件")),"the ring advances to verification and its hint names the current stage");
                form.SetUpdateProgress(new UpdateProgress{Stage="verify",Received=1,Total=1});form.SetUpdateProgress(new UpdateProgress{Stage="installed",Received=1,Total=2,Unit="files"});
                check(form.UpdateView.OverallPercent==99,"the final installation recheck does not rewind the ring");
                form.SetUpdateProgress(new UpdateProgress{Stage="failed",Code="checksum"});
                check(form.UpdateView.OverallPercent==99&&form.UpdateView.Hint.Contains(L.Text(UpdateProgress.Failure("checksum"))),"a failed update preserves its last progress and the specific failure reason");
                form.SetUpdateProgress(new UpdateProgress{Stage="installed"});check(form.UpdateView.OverallPercent==0,"retrying after failure starts a fresh progress ring");
                form.OpenSettings();form.Settings.ShowAbout();var view=form.Settings;form.Settings.SetUpdateProgress(value);form.Settings.SetUpdateStatus(value.Title);check(form.Settings==view&&form.OwnedForms.Length==0,"settings update progress refreshes inside the same page");
                form.SetUpdateProgress(new UpdateProgress{Stage="restart",Received=1,Total=1});form.CloseSettings();Application.DoEvents();
                check(form.UpdateView.OverallPercent==100&&form.UpdateView.Visible,"updates received while Settings is open appear on the ring when returning home");
                form.SetUpdateProgress(null);check(!form.UpdateView.Visible&&form.UpdateView.OverallPercent==0,"clearing progress removes the ring and its previous percentage");
            }
            string root=Path.Combine(directory,"update-worker"),state=Path.Combine(root,"state");Directory.CreateDirectory(Path.Combine(root,"app"));
            File.WriteAllText(Path.Combine(root,"app","update.ps1"),"[Console]::WriteLine('{\"type\":\"progress\",\"stage\":\"download\",\"received\":30,\"total\":100,\"unit\":\"bytes\"}');[Console]::Out.Flush();Start-Sleep -Milliseconds 400;[Console]::WriteLine('{\"status\":\"failed\",\"code\":\"checksum\"}');exit 1");
            int ui=Thread.CurrentThread.ManagedThreadId;bool live=false,onUi=true,exited=false;UpdateController controller=null;
            using(var owner=new Form()){owner.Show();Application.DoEvents();
            var previousContext=SynchronizationContext.Current;SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());try{
            using(controller=new UpdateController(root,state,false,delegate{},delegate{exited=true;},delegate(UpdateProgress update){if(update==null)return;onUi&=Thread.CurrentThread.ManagedThreadId==ui;if(update.Stage=="download")live=controller.Installing;})){
                controller.Install();DateTime deadline=DateTime.UtcNow.AddSeconds(12);while(controller.Installing&&DateTime.UtcNow<deadline){Application.DoEvents();Thread.Sleep(10);}Application.DoEvents();
                check(live&&onUi,"worker progress reaches the UI thread before the update process finishes");
                check(!controller.Installing&&!exited&&controller.Progress!=null&&controller.Progress.Stage=="failed"&&controller.Progress.Code=="checksum","structured failures preserve their reason and never launch an update helper");
            }
            }finally{SynchronizationContext.SetSynchronizationContext(previousContext);}
            }
        }
        static void RepaintTests(string directory,Action<bool,string> check){
            foreach(bool dark in new[]{false,true})using(var form=new Manager(true)){
                form.ClientSize=new Size(882,605);form.Show();form.SetTheme(dark);
                var first=form.Cards["preview-a"];first.SetExpanded(true,false);Application.DoEvents();
                int scroll=form.ScrollOffset;
                var progress=new UpdateProgress{Stage="installed",Received=2654,Total=4202,Unit="files"};
                Rectangle before=form.list.Bounds;form.SetUpdateProgress(progress);
                check(form.list.Bounds==before&&form.ScrollOffset==scroll,"showing the progress ring preserves card viewport and scrolling in theme "+dark);
                Application.DoEvents();before=form.list.Bounds;form.SetUpdateProgress(null);
                check(form.list.Bounds==before&&form.ScrollOffset==scroll,"hiding the progress ring preserves card viewport and scrolling in theme "+dark);
                Application.DoEvents();bool fits=true;
                foreach(var size in new[]{new Size(882,605),new Size(1100,720),new Size(660,500),new Size(1440,850)}){
                    form.ClientSize=size;form.ScrollOffset=40;Application.DoEvents();
                    foreach(var value in new[]{progress,null,progress}){
                        form.SetUpdateProgress(value);form.RefreshState();Application.DoEvents();
                        fits&=form.LayoutFits()&&form.Cards.Values.All(c=>c.Width==form.list.ClientSize.Width-2)&&!form.list.NativeBarsVisible;
                    }
                }
                check(fits,"expanded cards fit the settled viewport through update show/hide and window resizing in theme "+dark);
                Rectangle stable=form.list.Bounds;bool retained=first.Expanded;
                for(int i=0;i<20;i++){form.SetUpdateProgress(new UpdateProgress{Stage="installed",Received=i,Total=20,Unit="files"});Application.DoEvents();retained&=stable==form.list.Bounds&&Object.ReferenceEquals(first,form.Cards["preview-a"])&&first.Expanded;}
                check(retained,"progress packets preserve card identity, expansion and viewport bounds in theme "+dark);
            }
        }
    }
}
