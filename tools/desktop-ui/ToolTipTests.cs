using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CMCP {
    internal static class ToolTipTests {
        [System.Runtime.InteropServices.DllImport("user32.dll")]static extern IntPtr GetFocus();
        static readonly BindingFlags fields=BindingFlags.NonPublic|BindingFlags.Instance;
        static LocalToolTip.TipWindow Window(LocalToolTip tips){return (LocalToolTip.TipWindow)typeof(LocalToolTip).GetField("popup",fields).GetValue(tips);}
        static void Enter(Control control){typeof(Control).GetMethod("OnMouseEnter",fields).Invoke(control,new object[]{EventArgs.Empty});}
        static void Until(Func<bool> condition){var end=DateTime.UtcNow.AddSeconds(4);do{Application.DoEvents();if(condition())return;Thread.Sleep(15);}while(DateTime.UtcNow<end);throw new Exception("Tooltip did not reach its expected visible state");}
        static void Capture(Manager form,LocalToolTip.TipWindow popup,string file){
            var bounds=Rectangle.Union(TrayDisplay.Bounds(form),TrayDisplay.Bounds(popup));
            using(var image=new Bitmap(bounds.Width,bounds.Height)){using(var g=Graphics.FromImage(image))g.CopyFromScreen(bounds.Location,Point.Empty,bounds.Size);image.Save(file);}
        }
        internal static int Run(string output){
            Directory.CreateDirectory(output);var checks=new List<string>();
            Action<bool,string> check=(pass,name)=>{if(!pass)throw new Exception(name);checks.Add(name);File.WriteAllText(Path.Combine(output,"progress.txt"),String.Join("\n",checks));};
            var pointer=Cursor.Position;string language=L.Language;var context=TrayDisplay.Context;
            try{
                using(var form=new Manager(true)){
                    form.ClientSize=new Size(882,505);form.Show();form.Activate();
                    var bar=form.Controls.OfType<DashboardToolbar>().Single();var card=form.Cards.Values.First();var button=card.LoginSwitch;
                    var toolbarTips=(LocalToolTip)typeof(DashboardToolbar).GetField("tips",fields).GetValue(bar);
                    var toolbarSource=(Dictionary<Control,string>)typeof(LocalToolTip).GetField("source",fields).GetValue(toolbarTips);
                    check(!toolbarSource.ContainsKey(bar.Settings)&&!toolbarSource.ContainsKey(bar.Add),"settings and add-device buttons no longer carry hover explanations");
                    var tips=(LocalToolTip)typeof(TargetCard).GetField("tips",fields).GetValue(card);
                    var source=(Dictionary<Control,string>)typeof(LocalToolTip).GetField("source",fields).GetValue(tips);
                    check(!source.ContainsKey(card),"the card no longer carries the expand-and-sort explanation");
                    foreach(bool dark in new[]{true,false}){
                        L.Set("zh-CN");form.SetTheme(dark);Application.DoEvents();form.Activate();card.TestHover(true);Cursor.Position=button.PointToScreen(new Point(button.Width/2,button.Height/2));Application.DoEvents();button.Focus();Application.DoEvents();var focusBefore=GetFocus();Enter(button);
                        try{Until(()=>Window(tips)!=null&&Window(tips).Visible);}catch(Exception e){throw new Exception(e.Message+" focus="+form.ContainsFocus+" active="+(Form.ActiveForm==form)+" pointer="+Cursor.Position+" control="+button.RectangleToScreen(button.ClientRectangle)+" current="+(typeof(LocalToolTip).GetField("current",fields).GetValue(tips)==button)+" waiting="+typeof(LocalToolTip).GetField("waiting",fields).GetValue(tips),e);}var popup=Window(tips);popup.Refresh();Application.DoEvents();
                        var colors=Palette.Create(dark);
                        using(var image=new Bitmap(popup.Width,popup.Height)){popup.DrawToBitmap(image,popup.ClientRectangle);check(image.GetPixel(7,popup.Height/2).ToArgb()==colors.Subtle.ToArgb(),(dark?"dark":"light")+" tooltip paints the application background color");}
                        check(popup.ForeColor==colors.Text&&popup.Font.Unit==GraphicsUnit.Pixel&&popup.Font.Size>=14&&!popup.Region.IsVisible(Point.Empty),(dark?"dark":"light")+" tooltip has matching text contrast, a readable font and rounded corners");
                        check(form.ContainsFocus&&GetFocus()==focusBefore&&TrayDisplay.Context==context,(dark?"dark":"light")+" tooltip leaves keyboard focus and main-window DPI awareness unchanged");
                        Capture(form,popup,Path.Combine(output,dark?"dark.png":"light.png"));tips.Hide();
                    }
                    Enter(button);Until(()=>Window(tips).Visible);var visible=Window(tips);
                    form.SetTheme(true);Application.DoEvents();
                    check(!visible.Visible||visible.BackColor==Palette.Create(true).Subtle,"theme changes never leave a tooltip using the old colors");
                    if(!visible.Visible){button.Focus();Cursor.Position=button.PointToScreen(new Point(button.Width/2,button.Height/2));Application.DoEvents();Enter(button);Until(()=>Window(tips).Visible);visible=Window(tips);}
                    L.Set("en");Application.DoEvents();check(visible.Visible&&visible.AccessibleName=="Switch sign-in: shared web / SSH","visible tooltip text follows language changes");
                    tips.SetToolTip(button,"设置",true);Application.DoEvents();check(visible.AccessibleName=="设置","user-written notes stay literal when the interface language changes");
                    int shortHeight=visible.Height;
                    tips.SetToolTip(button,"A long tooltip keeps Chinese 中文 and English text readable, wraps inside the display, and never truncates important information. "+new string('W',100));Application.DoEvents();
                    check(visible.Height>shortHeight&&visible.Width<700&&visible.AccessibleName.Contains("中文"),"long bilingual hints wrap instead of being clipped");
                    check(TrayDisplay.WorkingArea(TrayDisplay.Pointer()).Contains(TrayDisplay.Bounds(visible)),"popup stays inside the current display work area");
                    typeof(Control).GetMethod("OnMouseDown",fields).Invoke(button,new object[]{new MouseEventArgs(MouseButtons.Left,1,3,3,0)});
                    check(!visible.Visible,"pressing the hinted button dismisses the popup before its action");
                    Enter(button);Cursor.Position=form.PointToScreen(new Point(10,200));typeof(Control).GetMethod("OnMouseLeave",fields).Invoke(button,new object[]{EventArgs.Empty});
                    var end=DateTime.UtcNow.AddMilliseconds(600);while(DateTime.UtcNow<end){Application.DoEvents();Thread.Sleep(15);}
                    check(!visible.Visible,"leaving before the delay cancels a pending tooltip");
                    Cursor.Position=button.PointToScreen(new Point(button.Width/2,button.Height/2));Application.DoEvents();Enter(button);Until(()=>visible.Visible);form.Left+=1;Application.DoEvents();
                    check(!visible.Visible,"moving the owner window hides the popup");
                    tips.Dispose();check(visible.IsDisposed,"disposing tooltip owners releases their popup windows");
                    form.Hide();form.Show();form.Activate();Application.DoEvents();
                    form.SetUpdateProgress(new UpdateProgress{Stage="download",Received=37,Total=100});var ring=form.UpdateView;
                    var ringTips=(LocalToolTip)typeof(UpdateProgressRing).GetField("tips",fields).GetValue(ring);
                    Cursor.Position=form.PointToScreen(new Point(10,200));ring.Focus();
                    Until(()=>Window(ringTips)!=null&&Window(ringTips).Visible);
                    var ringPopup=Window(ringTips);check(ring.Focused&&ringPopup.AccessibleName.Contains("37%"),"keyboard focus shows the ring's measured progress without moving the pointer over it");
                    form.SetUpdateProgress(new UpdateProgress{Stage="download",Received=75,Total=100});Application.DoEvents();
                    check(ringPopup.Visible&&ringPopup.AccessibleName.Contains("75%"),"a visible progress tooltip refreshes as new counters arrive");
                }
                File.WriteAllText(Path.Combine(output,"tooltips.json"),new JavaScriptSerializer().Serialize(new{passed=checks.Count,failed=0,checks=checks}),System.Text.Encoding.UTF8);return 0;
            }catch(Exception e){File.WriteAllText(Path.Combine(output,"tooltips.json"),new JavaScriptSerializer().Serialize(new{passed=checks.Count,failed=1,error=e.ToString(),checks=checks}),System.Text.Encoding.UTF8);return 1;}
            finally{Cursor.Position=pointer;L.Set(language);}
        }
    }
}
