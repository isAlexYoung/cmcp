using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeMcp {
    internal static class DashboardTests {
        internal static int? DarkCaptionResult, LightCaptionResult;
        static void Pump(){Application.DoEvents();}
        internal static void Run(string temp,Action<bool,string> check){
            string directory=Path.Combine(temp,"dashboard");Directory.CreateDirectory(directory);
            var targets=Manager.Demo().Targets;var prefs=UiPreferences.Load(directory);
            check(!prefs.ReadError&&prefs.Sort(targets)[0].Name=="preview-a","fresh UI preferences preserve existing connection order");
            prefs.Set("preview-a","我的工作电脑","",targets);prefs.Move("preview-b","preview-a",targets);prefs.dark=true;prefs.Save(directory);
            var loaded=UiPreferences.Load(directory);
            check(!loaded.ReadError&&loaded.dark&&loaded.Get("preview-a").label=="我的工作电脑"&&loaded.Sort(targets)[0].Name=="preview-b","Unicode remarks, theme and order persist separately from target IDs");
            check(!File.Exists(Path.Combine(directory,"cloudpc-targets.json"))&&!File.Exists(Path.Combine(directory,"target-controls.json")),"presentation saves never create backend configuration or switches");
            string image=Path.Combine(directory,"icon.png");using(var b=new Bitmap(48,32)){using(var g=Graphics.FromImage(b))g.Clear(Color.OrangeRed);b.Save(image,System.Drawing.Imaging.ImageFormat.Png);}
            string encoded=UiPreferences.ImportIcon(image);using(var b=UiPreferences.DecodeIcon(encoded))check(b.Width==72&&b.Height==72,"custom icon normalizes to a detached 72px PNG");
            prefs.Set("preview-a","我的工作电脑",encoded,targets);prefs.Save(directory);check(UiPreferences.Load(directory).Get("preview-a").icon==encoded,"custom icon persists without referencing user image path");
            File.Delete(image);using(var b=UiPreferences.DecodeIcon(UiPreferences.Load(directory).Get("preview-a").icon))check(b.Width==72,"deleting original icon does not break saved card");
            File.WriteAllText(UiPreferences.PathFor(directory),"{");var bad=UiPreferences.Load(directory);bool refused=false;try{bad.Save(directory);}catch(IOException){refused=true;}
            check(bad.ReadError&&refused&&File.ReadAllText(UiPreferences.PathFor(directory))=="{","malformed UI preferences are not overwritten");
            File.WriteAllText(UiPreferences.PathFor(directory),"{\"schema\":1,\"cards\":[{\"name\":\"a\",\"icon\":\"invalid\"}]}");check(UiPreferences.Load(directory).ReadError,"invalid custom image metadata fails closed");
            File.WriteAllText(UiPreferences.PathFor(directory),new string('x',UiPreferences.MaxBytes+1));check(UiPreferences.Load(directory).ReadError,"presentation file has a fixed size bound");File.Delete(UiPreferences.PathFor(directory));
            var many=new UiPreferences();for(int i=0;i<101;i++)many.cards.Add(new CardPreference{name="item-"+i});bool capped=false;try{many.Save(directory);}catch(IOException){capped=true;}check(capped,"presentation entries capped at 100");
            using(var form=new Manager(true)){
                form.Show();Pump();var a=form.Cards["preview-a"];var b=form.Cards["preview-b"];
                check(form.LayoutFits(),"real wide WinForms cards and toolbar fit inside window");
                check(a.Connect.Text=="成功连接"&&a.Connect.Primary&&b.Connect.Text=="未连接"&&!b.Connect.Primary,"connection pill reflects confirmed versus disconnected state");
                b.TestHover(true);b.Connect.PerformClick();check(b.Target.State=="connected"&&a.Target.State=="connected","card connect dispatch addresses B only in isolated interactive demo");
                b.Connect.PerformClick();check(b.Target.State=="stopped"&&a.Target.State=="connected","card disconnect leaves A intact in isolated interactive demo");
                a.SetExpanded(true,false);Pump();check(a.Details.Visible&&a.Height>a.Width/20&&b.Top>=a.Bottom,"accordion expands inside card and shifts following card");
                a.Toggle.PerformClick();a.SetExpanded(false,false);Pump();check(!a.Details.Visible&&a.Height==116,"accordion collapse restores enlarged 116px header height");
                a.SetExpanded(true,false);form.RefreshState();Pump();check(Object.ReferenceEquals(a,form.Cards["preview-a"])&&a.Expanded,"status polling preserves card instance and expanded state");
                a.TestHover(false);check(!a.Edit.Visible&&!a.Copy.Visible&&!a.Delete.Visible,"secondary card actions hide outside hover");a.TestHover(true);check(a.Edit.Visible&&a.Copy.Visible&&a.Delete.Visible,"secondary card actions reveal on hover");
                form.MoveCard("preview-b","preview-a");Pump();check(b.Top<a.Top,"reorder moves existing controls without reconnecting targets");
                form.DropMove("preview-b","preview-a",true);Pump();check(a.Top<b.Top,"dragging onto lower half can move first card to end");
                form.DropMove("preview-b","preview-a",false);Pump();check(b.Top<a.Top,"dragging onto upper half can move card to start");
                b.BeginKeyboardNavigation();b.Focus();Pump();check(b.Selected&&b.Edit.Visible&&b.CanFocus,"keyboard focus selects card and reveals accessible actions");
                check(form.Cards.Values.Count(c=>c.Selected)==1,"exactly one current card has selected styling");
                foreach(var size in new[]{new Size(660,500),new Size(800,600),new Size(1100,720),new Size(1440,850)}){
                    form.ClientSize=size;Pump();check(form.LayoutFits(),"responsive layout fits at "+size.Width+"x"+size.Height);
                }
                form.SetTheme(true);Pump();DarkCaptionResult=NativeFrame.LastCaptionResult;check(form.Preferences.dark&&a.Colors.Dark&&a.Details.Colors.Dark,"dark theme reaches cards and nested details");form.SetTheme(false);Pump();LightCaptionResult=NativeFrame.LastCaptionResult;check(!a.Colors.Dark,"light theme restores semantic colors");
                var bar=form.Controls.OfType<DashboardToolbar>().Single();check(!bar.Settings.Enabled&&!bar.UpdateButton.Enabled&&bar.Add.Enabled,"future settings and update remain explicitly disabled; add works");
                check(!File.Exists(Path.Combine(directory,"config.json")),"all UI tests use isolated state and never create a bridge token");
                check(form.Text=="CMCP","native title contains only CMCP");
                check(form.Controls.Count==2&&!form.Controls.OfType<FlowLayoutPanel>().Any(),"main page has no footer or bottom links");
                check(a.Font.Size==11F&&a.Connect.Height==40&&a.Edit.Width==36&&a.Connect.Width==136,"card text and interactive controls are enlarged together");
                b.ClearPointer();form.RefreshState();Pump();check(b.StatusText.Visible&&b.StatusText.Text=="已停止"&&!b.ActionsVisible,"idle card always shows stopped status without action buttons");
                b.BusyConnect=true;b.UpdateActions();check(b.StatusText.Visible&&b.StatusText.Text=="连接中","pending connect immediately exposes a nonempty status");b.BusyConnect=false;
                b.TestHover(true);b.Connect.PerformClick();b.ClearPointer();Pump();check(b.StatusText.Visible&&b.StatusText.Text=="已连接"&&!b.ActionsVisible,"leaving a just-connected card restores confirmed status immediately");
                b.TestHover(true);check(b.ActionsVisible&&!b.StatusText.Visible,"hover replaces idle status with full action set");
                b.ClearPointer();for(int i=0;i<20;i++){b.TestHover(true);b.ClearPointer();b.UpdateActions();}
                check(b.StatusText.Visible&&!b.ActionsVisible&&b.StatusText.Text.Length>0,"repeated hover exits and state updates never leave a blank status slot");
                bool wasExpanded=b.Expanded;
                b.TestHover(true);b.Edit.PerformClick();Pump();
                check(form.Editor!=null&&form.Editor.Parent==form&&form.OwnedForms.Length==0,"edit opens an embedded page without creating an owned window");
                check(form.Editor.LayoutFits&&form.Editor.Back.Visible&&form.Editor.Save.Visible,"embedded edit page provides return and save controls");
                form.Editor.NameInput.Box.Text="未保存名称";form.Editor.Back.PerformClick();Pump();
                check(form.Editor==null&&form.Preferences.Get(b.Target.Name).label==""&&b.Expanded==wasExpanded,"back discards unsaved edits and preserves list expansion");
                form.OpenEditor(b.Target.Name);Pump();form.Editor.UrlInput.Box.Text="http://invalid.example";form.Editor.Save.PerformClick();Pump();
                check(form.Editor!=null,"invalid URL remains on the edit page without starting a process");
                form.Editor.UrlInput.Box.Text=b.Target.Url;form.Editor.NameInput.Box.Text="我的第二台云电脑";form.Editor.Save.PerformClick();Pump();
                b=form.Cards["preview-b"];
                check(form.Editor==null&&b.Preference.label=="我的第二台云电脑"&&b.Target.State=="connected"&&a.Target.State=="connected","embedded save updates remark and retains both connections");
                form.OpenEditor(b.Target.Name);Pump();
                foreach(var size in new[]{new Size(660,500),new Size(1100,720)}){form.ClientSize=size;Pump();check(form.Editor.LayoutFits,"edit page fits at "+size.Width+"x"+size.Height);}
                form.Editor.Back.PerformClick();Pump();
            }
            string manyFile=Path.Combine(directory,"cloudpc-targets.json");
            var records=Enumerable.Range(0,30).Select(i=>new {name="entry-"+i,url="https://desktop"+i+".invalid",authMode="shared-browser"}).ToArray();
            File.WriteAllText(manyFile,new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(records));
            using(var form=new Manager(false,directory)){
                form.ClientSize=new Size(660,500);form.Show();Pump();
                check(form.Cards.Count==30&&form.LayoutFits(),"30 real saved cards stay within narrow list without horizontal overflow");
                form.ScrollOffset=700;Pump();int before=form.ScrollOffset;form.RefreshState();Pump();check(before>0&&form.ScrollOffset==before,"periodic status refresh preserves vertical scroll position");
            }
            File.Delete(manyFile);
            string command=Actions.Command("C:\\app","edit","a'b","https://example.com/'");check(command.Contains("-TargetName 'a''b'")&&command.Contains("-InitialUrl 'https://example.com/'''"),"edit keeps stable ID and escapes both arguments literally");
            bool missing=false;try{Actions.Command("C:\\app","remove","");}catch(ArgumentException){missing=true;}check(missing,"delete cannot dispatch without an explicit target");
            if(File.Exists(UiPreferences.PathFor(directory)))File.Delete(UiPreferences.PathFor(directory));Directory.Delete(directory,false);
        }
    }
}
