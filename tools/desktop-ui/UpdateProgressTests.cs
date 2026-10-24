using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace CMCP {
    internal static class UpdateProgressTests {
        internal static void Run(string directory,Action<bool,string> check){
            var packet=new Dictionary<string,object>{{"type","progress"},{"stage","download"},{"received",30},{"total",100},{"unit","bytes"},{"message","DO-NOT-DISPLAY"}};
            var value=UpdateProgress.Read(packet);check(value.Percent==30&&!value.Detail.Contains("DO-NOT-DISPLAY"),"update progress shows measured bytes and ignores untrusted message text");
            packet["received"]=101;bool rejected=false;try{UpdateProgress.Read(packet);}catch(InvalidDataException){rejected=true;}check(rejected,"invalid progress counters cannot overflow or report a false completion");
            using(var form=new Manager(true)){
                form.Show();form.SetUpdateProgress(value);Application.DoEvents();check(form.UpdateView.Visible&&form.UpdateView.Value.Percent==30&&form.OwnedForms.Length==0,"update progress is embedded in the main window");
                foreach(bool dark in new[]{false,true}){form.SetTheme(dark);form.ClientSize=new Size(660,500);Application.DoEvents();using(var image=new Bitmap(form.Width,form.Height))form.DrawToBitmap(image,new Rectangle(Point.Empty,image.Size));check(form.UpdateView.Visible&&form.UpdateView.Width<=form.ClientSize.Width,"update progress remains visible at narrow width in theme "+dark);}
                form.OpenSettings();form.Settings.ShowAbout();var view=form.Settings;form.Settings.SetUpdateProgress(value);form.Settings.SetUpdateStatus(value.Title);check(form.Settings==view&&form.OwnedForms.Length==0,"settings update progress refreshes inside the same page");
            }
            string root=Path.Combine(directory,"update-worker"),state=Path.Combine(root,"state");Directory.CreateDirectory(Path.Combine(root,"app"));
            File.WriteAllText(Path.Combine(root,"app","update.ps1"),"[Console]::WriteLine('{\"type\":\"progress\",\"stage\":\"download\",\"received\":30,\"total\":100,\"unit\":\"bytes\"}');[Console]::Out.Flush();Start-Sleep -Milliseconds 400;[Console]::WriteLine('{\"status\":\"failed\",\"code\":\"checksum\"}');exit 1");
            int ui=Thread.CurrentThread.ManagedThreadId;bool live=false,onUi=true,exited=false;UpdateController controller=null;
            using(controller=new UpdateController(root,state,false,delegate{},delegate{exited=true;},delegate(UpdateProgress update){if(update==null)return;onUi&=Thread.CurrentThread.ManagedThreadId==ui;if(update.Stage=="download")live=controller.Installing;})){
                controller.Install();DateTime deadline=DateTime.UtcNow.AddSeconds(12);while(controller.Installing&&DateTime.UtcNow<deadline){Application.DoEvents();Thread.Sleep(10);}Application.DoEvents();
                check(live&&onUi,"worker progress reaches the UI thread before the update process finishes");
                check(!controller.Installing&&!exited&&controller.Progress!=null&&controller.Progress.Stage=="failed"&&controller.Progress.Code=="checksum","structured failures preserve their reason and never launch an update helper");
            }
        }
    }
}
