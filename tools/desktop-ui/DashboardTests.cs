using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeMcp {
    internal static class DashboardTests {
        internal static Action<string> Trace;
        internal static int? DarkCaptionResult, LightCaptionResult;
        static void Pump(){Application.DoEvents();}
        static bool Until(Func<bool> condition,Manager form){var until=DateTime.UtcNow.AddSeconds(12);do{Pump();form.RefreshState();if(condition())return true;System.Threading.Thread.Sleep(30);}while(DateTime.UtcNow<until);return false;}
        // Keep the previous painted pixels and repaint ONLY the regions WinForms
        // invalidates during a real resize. DrawToBitmap alone forces a full
        // repaint, which masked the user's stale-border bug in earlier tests.
        sealed class RetainedSurface : IDisposable {
            readonly Control control;
            readonly Bitmap pixels=new Bitmap(2200,900);
            readonly int oldWidth;
            Rectangle dirty=Rectangle.Empty;
            readonly InvalidateEventHandler invalidated;
            static readonly System.Reflection.BindingFlags flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance;
            internal RetainedSurface(Control item){
                control=item;oldWidth=item.Width;Paint(item.ClientRectangle);
                invalidated=delegate(object sender,InvalidateEventArgs e){dirty=dirty.IsEmpty?e.InvalidRect:Rectangle.Union(dirty,e.InvalidRect);};control.Invalidated+=invalidated;
            }
            void Paint(Rectangle clip){
                if(clip.IsEmpty)return;
                using(var g=Graphics.FromImage(pixels)){
                    g.SetClip(clip);var e=new PaintEventArgs(g,clip);
                    typeof(Control).GetMethod("OnPaintBackground",flags).Invoke(control,new object[]{e});
                    typeof(Control).GetMethod("OnPaint",flags).Invoke(control,new object[]{e});
                }
            }
            internal bool Cleared(){
                Paint(Rectangle.Intersect(control.ClientRectangle,dirty));
                Color expected=control is RoundedSheet?((RoundedSheet)control).Colors.Surface:control.BackColor;
                return control.Width>oldWidth+30&&pixels.GetPixel(oldWidth-2,control.Height/2).ToArgb()==expected.ToArgb();
            }
            public void Dispose(){control.Invalidated-=invalidated;pixels.Dispose();}
        }
        static System.Collections.Generic.IEnumerable<Control> Descendants(Control parent){foreach(Control c in parent.Controls){yield return c;foreach(var child in Descendants(c))yield return child;}}
        static void TestEditorResize(Manager form,Action<bool,string> check,bool adding,bool dark){
            form.SetTheme(dark);if(adding)form.OpenAdd();else form.OpenEditor("preview-a");
            form.ClientSize=new Size(800,720);Pump();form.Editor.NameInput.Box.Focus();Pump();
            var surfaces=Descendants(form.Editor).Where(c=>c is EditorInput||c is RoundedSheet).Select(c=>new RetainedSurface(c)).ToArray();
            try{form.ClientSize=new Size(1320,720);Pump();check(surfaces.All(s=>s.Cleared()),(adding?"add":"edit")+" "+(dark?"dark":"light")+" resize repaints retained input and outer sheet borders");}
            finally{foreach(var surface in surfaces)surface.Dispose();form.CloseEditor();}
        }
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
                form.Trace=Trace;
                form.Show();Pump();var a=form.Cards["preview-a"];var b=form.Cards["preview-b"];
                check(form.LayoutFits(),"real wide WinForms cards and toolbar fit inside window");
                check(a.Connect.Text=="成功连接"&&a.Connect.Primary&&b.Connect.Text=="未连接"&&!b.Connect.Primary,"connection pill reflects confirmed versus disconnected state");
                b.TestHover(true);b.Connect.PerformClick();check(b.Target.State=="connected"&&a.Target.State=="connected","card connect dispatch addresses B only in isolated interactive demo");
                b.Connect.PerformClick();check(b.Target.State=="stopped"&&a.Target.State=="connected","card disconnect leaves A intact in isolated interactive demo");
                a.SetExpanded(true,false);Pump();check(a.Details.Visible&&a.Height>a.Width/20&&b.Top>=a.Bottom,"accordion expands inside card and shifts following card");
                a.Toggle.PerformClick();a.SetExpanded(false,false);Pump();check(!a.Details.Visible&&a.Height==116,"accordion collapse restores enlarged 116px header height");
                a.SetExpanded(true,false);form.RefreshState();Pump();check(Object.ReferenceEquals(a,form.Cards["preview-a"])&&a.Expanded,"status polling preserves card instance and expanded state");
                a.TestHover(false);check(!a.Edit.Visible&&!a.Copy.Visible&&!a.Delete.Visible,"secondary card actions hide outside hover");a.TestHover(true);check(a.Edit.Visible&&a.Copy.Visible&&a.Delete.Visible,"secondary card actions reveal on hover");
                form.MoveCard("preview-b","preview-a");check(form.list.Moving,"sorting starts a real position transition");form.list.FinishMotion();Pump();check(b.Top<a.Top,"reorder moves existing controls without reconnecting targets");
                form.DropMove("preview-b","preview-a",true);form.list.FinishMotion();Pump();check(a.Top<b.Top,"dragging onto lower half can move first card to end");
                form.DropMove("preview-b","preview-a",false);form.list.FinishMotion();Pump();check(b.Top<a.Top,"dragging onto upper half can move card to start");
                var orderBefore=form.Preferences.Sort(targets).Select(t=>t.Name).ToArray();
                form.list.BeginSort(b,b.Top+35);form.list.MoveSort(a.Bottom-10);
                check(form.list.Sorting&&form.Preferences.Sort(targets).Select(t=>t.Name).SequenceEqual(orderBefore),"drag preview moves controls without saving preferences");
                form.list.EndSort(false);form.list.FinishMotion();Pump();check(b.Top<a.Top,"cancelled drag restores original order");
                form.list.BeginSort(b,b.Top+35);form.list.MoveSort(a.Bottom-10);form.list.EndSort(true);form.list.FinishMotion();Pump();check(a.Top<b.Top,"pointer drag commits new order on release");
                bool oldExpanded=b.Expanded;int opens=0;b.OpenRequested+=delegate{opens++;};
                b.TestCardClick(160,76);check(opens==0&&b.Expanded!=oldExpanded,"clicking card URL only toggles details, never opens cloud desktop");b.SetExpanded(false,false);
                form.OpenAdd();Pump();check(form.Editor!=null&&form.Editor.IsNew&&form.Editor.Parent==form&&form.OwnedForms.Length==0,"add uses the same embedded page with no popup");
                form.Editor.Back.PerformClick();Pump();check(form.Editor==null,"add back returns to unchanged card list");
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
                b.ClearPointer();form.RefreshState();Pump();b.ClearPointer();check(b.StatusText.Visible&&b.StatusText.Text=="已停止"&&!b.ActionsVisible,"idle card always shows stopped status without action buttons");
                b.BusyConnect=true;b.UpdateActions();check(b.StatusText.Visible&&b.StatusText.Text=="连接中","pending connect immediately exposes a nonempty status");b.BusyConnect=false;
                b.TestHover(true);b.Connect.PerformClick();b.ClearPointer();Pump();b.ClearPointer();check(b.StatusText.Visible&&b.StatusText.Text=="已连接"&&!b.ActionsVisible,"leaving a just-connected card restores confirmed status immediately");
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
                var previousCard=b;
                form.Editor.UrlInput.Box.Text=b.Target.Url;form.Editor.NameInput.Box.Text="我的第二台云电脑";form.Editor.Save.PerformClick();Pump();
                b=form.Cards["preview-b"];
                check(form.Editor==null&&b.Preference.label=="我的第二台云电脑"&&b.Target.State=="connected"&&a.Target.State=="connected","embedded save updates remark and retains both connections");
                check(Object.ReferenceEquals(previousCard,b),"saving presentation keeps the live card and its controls intact");
                form.OpenEditor(b.Target.Name);Pump();
                foreach(var size in new[]{new Size(660,500),new Size(1100,720)}){form.ClientSize=size;Pump();check(form.Editor.LayoutFits,"edit page fits at "+size.Width+"x"+size.Height);}
                form.Editor.Back.PerformClick();Pump();
                var parent=a.Parent;
                parent.Controls.Remove(a);
                try{form.RefreshState();Pump();check(a.Parent==null&&!a.IsDisposed&&b.Parent==parent,"layout reentry never indexes a temporarily detached card");}
                finally{parent.Controls.Add(a);form.RefreshState();Pump();}
                TestEditorResize(form,check,true,false);TestEditorResize(form,check,false,false);
                TestEditorResize(form,check,true,true);TestEditorResize(form,check,false,true);
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
            InlineTests(temp,check);
            using(var page=new TargetEditorPage(new Target{Name="",Url=""},new CardPreference(),Palette.Create(false))){
                check(!page.AutoLogin,"new target never enables saved shared login implicitly");
                page.UrlInput.Box.Text="https://auto.invalid";page.Remember.Checked=true;
                check(!page.ValidateFields(),"checked auto login requires a password before launching validation");
                page.PasswordInput.Box.Text=" exact 密码 '$() ";check(page.ValidateFields()&&page.Password==" exact 密码 '$() ","shared password input preserves exact text and supports explicit auto choice");
            }
            using(var page=new TargetEditorPage(new Target{Name="saved",Url="https://auto.invalid",AutoLogin=true,HasSavedPassword=true},new CardPreference(),Palette.Create(true))){
                check(page.AutoLogin&&page.Password.Length==0,"editing remembered target shows checked option without exposing password");
                check(page.ValidateFields(),"same-origin saved password may be left blank");page.UrlInput.Box.Text="https://other.invalid";
                check(!page.ValidateFields(),"editor never forwards a saved secret to a changed origin");page.Remember.Checked=false;
                check(page.ValidateFields(),"unchecking auto login permits manual shared mode without a secret");
            }
        }
        static void InlineTests(string temp,Action<bool,string> check){
            string state=Path.Combine(temp,"inline"),kit=Path.Combine(state,"kit");Directory.CreateDirectory(kit);
            string targets=Path.Combine(state,"cloudpc-targets.json");
            string sender=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"app","manager-events.ps1");
            string pipeTest=Path.Combine(kit,"pipe.ps1"),completed=Path.Combine(kit,"pipe-completed");
            File.WriteAllText(pipeTest,". '"+sender.Replace("'","''")+"'\r\nStart-Sleep -Milliseconds 500\r\nSend-ManagerEvent 'progress' '管道已关闭也继续操作'\r\n[IO.File]::WriteAllText('"+completed.Replace("'","''")+"','1')\r\n",System.Text.Encoding.UTF8);
            var pipeInfo=new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+pipeTest+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true};
            using(var child=System.Diagnostics.Process.Start(pipeInfo)){child.StandardOutput.Close();if(!child.WaitForExit(10000)){child.Kill();throw new Exception("Closed-pipe fixture timed out");}check(child.ExitCode==0&&File.Exists(completed),"closing progress reader cannot abort the production worker event sender");}
            File.WriteAllText(targets,"[{\"name\":\"A\",\"url\":\"https://a.invalid\",\"authMode\":\"shared-browser\"},{\"name\":\"B\",\"url\":\"https://b.invalid\",\"authMode\":\"shared-browser\"}]");
            string utf8="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\r\n";
            File.WriteAllText(Path.Combine(kit,"start.ps1"),"param([string]$TargetName,[long]$RequestTime,[switch]$ManagerMode)\r\n"+utf8+"if(!$ManagerMode -or !$TargetName -or $RequestTime -le 0){exit 9}\r\n[Console]::WriteLine('{\"schema\":1,\"kind\":\"progress\",\"message\":\"正在等待网页登录\"}')\r\n$deadline=[DateTime]::UtcNow.AddSeconds(15)\r\nwhile(!(Test-Path -LiteralPath (Join-Path $PSScriptRoot ('stop-'+$TargetName)))){if([DateTime]::UtcNow -gt $deadline){exit 8};Start-Sleep -Milliseconds 30}\r\n[Console]::WriteLine('{\"schema\":1,\"kind\":\"error\",\"message\":\"过期进度不应覆盖\"}')\r\n",System.Text.Encoding.UTF8);
            File.WriteAllText(Path.Combine(kit,"stop.ps1"),"param([string]$TargetName,[long]$RequestTime,[switch]$ManagerMode)\r\n"+utf8+"if(!$ManagerMode -or !$TargetName -or $RequestTime -le 0){exit 9}\r\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot ('stop-'+$TargetName)),'1')\r\n",System.Text.Encoding.UTF8);
            File.WriteAllText(Path.Combine(kit,"manager-save.ps1"),utf8+"[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)\r\n$r=[Console]::ReadLine()|ConvertFrom-Json\r\nif($r.password -ne 'TESTONLY123' -or $r.url -ne 'https://c.invalid' -or $r.autoLogin -ne $true){exit 9}\r\n$f=Join-Path (Split-Path $PSScriptRoot -Parent) 'cloudpc-targets.json'\r\n$t=@([IO.File]::ReadAllText($f)|ConvertFrom-Json)\r\n$t+=@{name='C';url=$r.url;authMode='shared-browser';autoLogin=$r.autoLogin;password='TEST-ONLY-CIPHER'}\r\n[IO.File]::WriteAllText($f,(ConvertTo-Json -InputObject $t -Depth 4))\r\n[Console]::WriteLine('{\"schema\":1,\"kind\":\"saved\",\"message\":\"已保存\",\"name\":\"C\"}')",System.Text.Encoding.UTF8);
            using(var form=new Manager(false,state,kit)){
                form.Show();Pump();var a=form.Cards["A"];var b=form.Cards["B"];
                a.TestHover(true);a.Connect.PerformClick();
                check(a.BusyConnect&&a.Expanded&&a.Details.Stop.Enabled&&form.OwnedForms.Length==0,"real GUI launches hidden inline worker and immediately exposes cancel");
                b.TestHover(true);b.Connect.PerformClick();
                check(Until(()=>a.Target.Detail=="正在等待网页登录"&&b.Target.Detail=="正在等待网页登录",form),"Unicode worker progress reaches each card inside the main window");
                a.Details.Stop.PerformClick();
                check(a.BusyStop&&b.BusyConnect&&b.Details.Stop.Enabled,"stop A dispatches immediately while B remains independently cancellable");
                check(Until(()=>!a.BusyStop&&!a.BusyConnect&&a.Target.Detail=="此台连接已停止。",form)&&b.BusyConnect,"late cancelled progress cannot replace A stop result or stop B");
                b.Details.Stop.PerformClick();check(Until(()=>!b.BusyStop&&!b.BusyConnect,form),"B can also cancel without a confirmation or progress popup");
                form.OpenAdd();form.Editor.UrlInput.Box.Text="https://c.invalid";form.Editor.NameInput.Box.Text="第三台云电脑";form.Editor.Remember.Checked=true;form.Editor.PasswordInput.Box.Text="TESTONLY123";form.Editor.Save.PerformClick();
                check(form.Editor!=null&&form.Editor.Password.Length==0&&!form.Editor.Save.Enabled,"save clears password from editor and prevents duplicate submissions");
                check(Until(()=>form.Editor==null&&form.Cards.ContainsKey("C"),form)&&form.Cards["C"].Preference.label=="第三台云电脑"&&form.Cards["C"].Target.AutoLogin&&form.Cards["C"].Target.HasSavedPassword,"embedded add handles saved worker result and applies card metadata");
                // Check real resize layout and repaint buffers over repeated cycles.
                for(int i=0;i<12;i++){form.ClientSize=new Size(i%2==0?1380:680,650);Pump();}
                check(form.LayoutFits()&&form.Cards.Values.All(c=>c.Left==0),"repeated live resizing retains one fitted card rectangle per target");
                using(var image=new Bitmap(form.list.Width,form.list.Height)){form.list.DrawToBitmap(image,form.list.ClientRectangle);check(image.GetPixel(form.list.ClientSize.Width-2,5).ToArgb()==Palette.Create(false).Page.ToArgb(),"repaint clears the exposed list strip after repeated resizing");}
            }
            foreach(var file in new[]{"start.ps1","stop.ps1","manager-save.ps1","stop-A","stop-B","pipe.ps1","pipe-completed"})File.Delete(Path.Combine(kit,file));
            Directory.Delete(kit,false);File.Delete(targets);File.Delete(UiPreferences.PathFor(state));Directory.Delete(state,false);
        }
    }
}
