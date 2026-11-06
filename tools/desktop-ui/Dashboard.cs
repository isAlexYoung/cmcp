using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CMCP {
    internal sealed class Manager : Form {
        readonly string root = AppDomain.CurrentDomain.BaseDirectory;
        readonly string kit = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
        readonly string stateDirectory = PortableState.DirectoryPath;
        readonly bool preview;
        internal readonly DashboardToolbar toolbar = new DashboardToolbar();
        internal readonly CardList list = new CardList();
        readonly Label status = new Label(), count = new Label(), empty = new Label();
        readonly ResizePanel content = new ResizePanel();
        internal UpdateProgressRing UpdateView {get{return toolbar.Progress;}}
        internal TargetEditorPage Editor;
        internal SettingsPage Settings;
        internal AppSettings Options;
        readonly bool isolated;
        readonly Func<Point> trayPosition;
        NotifyIcon tray;
        internal TrayMenu TrayCommands;
        internal bool TrayVisible;
        bool exiting,updateNotice;
        internal bool ExitPending;
        internal Func<bool> ExitBackend;
        internal Func<int> RunUninstall;
        internal Func<string> FindUninstaller;
        internal Func<bool> ConfirmUninstall;
        Task<bool> backendInitialization;
        internal bool BackendStarting {get;private set;}
        UpdateController updates;
        internal Action<string> Trace;
        void Mark(string message){if(Trace!=null)Trace(message);}
        int editorScroll;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        // The update button moved to About, so a new version is announced by a dot instead.
        readonly System.Windows.Forms.Timer updateCheck = new System.Windows.Forms.Timer{Interval=15000};
        sealed class PendingAction { internal Process Process; internal InlineWorker Worker; internal string Name, Action, Label="", Icon="", Message="", Note="", SshFrom="", LoginMode=""; internal bool Superseded, Failed, Saved, DropSsh, DeleteSsh, HideAddress; internal SshLogin SshDraft; }
        readonly Dictionary<string,string> progress=new Dictionary<string,string>();
        readonly List<PendingAction> children = new List<PendingAction>();
        internal readonly Dictionary<string,TargetCard> Cards = new Dictionary<string,TargetCard>(StringComparer.Ordinal);
        internal UiPreferences Preferences;
        internal SshStore Ssh;
        internal Func<string,string,string> ReadSshState=SshWorkers.State;
        internal Func<string,string,bool> StopSshWorker=(directory,id)=>SshWorkers.Stop(directory,id);
        internal Func<string,string,int> CloseSshSessions=SshSessions.Close;
        readonly HashSet<string> sshStopping=new HashSet<string>(StringComparer.Ordinal);
        internal Action<ProcessStartInfo> StartTerminal=info=>{using(Process.Start(info)){}};
        Palette colors;
        List<Target> targets = new List<Target>();
        string selected = "", notice = "";
        bool arranging, previewInitialized;
        internal Manager(bool demo, string stateOverride = null, string kitOverride = null,Func<Point> trayPositionOverride=null) {
            trayPosition=trayPositionOverride;
            if (stateOverride != null) stateDirectory = stateOverride;
            if (kitOverride != null) kit = kitOverride;
            preview = demo;isolated=demo||stateOverride!=null; Preferences = demo ? new UiPreferences() : UiPreferences.Load(isolated?stateDirectory:PortableState.PreferencesPath);
            Ssh=demo?DemoSsh():SshStore.Load(stateDirectory);
            ExitBackend=isolated?(Func<bool>)(()=>true):(()=>BackendRestart.Run(kit,"manager-exit.ps1"));
            if(!isolated){
                RunUninstall=()=>{using(var process=Actions.Start(kit,"uninstall","")){process.WaitForExit();return process.ExitCode;}};
            FindUninstaller=isolated?(Func<string>)(()=>null):(()=>Installation.Uninstaller(AppDomain.CurrentDomain.BaseDirectory));
                ConfirmUninstall=()=>MessageBox.Show(this,L.Text("确定要卸载 CMCP 吗？\r\n\r\n将断开全部连接，移除云电脑上的 Claude 配置，并删除本机保存的地址、密码和设置。"),Text,MessageBoxButtons.YesNo,MessageBoxIcon.Warning,MessageBoxDefaultButton.Button2)==DialogResult.Yes;
            }
            Options=demo?new AppSettings():AppSettings.Load(isolated?stateDirectory:PortableState.PreferencesPath,!isolated&&StartupRegistration.Enabled());L.Set(Options.language);Preferences.dark=Options.IsDark(Preferences.dark);if(Options.theme.Length==0)Options.theme=Preferences.dark?"dark":"light";
            colors=Palette.Create(Preferences.dark);Text="CMCP";
            Icon=System.Drawing.Icon.ExtractAssociatedIcon(Program.ExecutablePath);
            Font=new Font("Microsoft YaHei UI",11F);AutoScaleMode=AutoScaleMode.Dpi;
            DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw,true);
            ClientSize=new Size(1100,720);MinimumSize=new Size(660,500);StartPosition=FormStartPosition.CenterScreen;
            content.Dock=DockStyle.Fill;content.Padding=new Padding(28,10,28,0);
            var heading = new Panel { Dock=DockStyle.Top, Height=66 };
            count.Bounds=new Rectangle(0,2,400,28);count.Font=new Font(Font.FontFamily,12F,FontStyle.Bold);heading.Controls.Add(count);
            status.Bounds=new Rectangle(0,34,850,24);status.Anchor=AnchorStyles.Left|AnchorStyles.Right|AnchorStyles.Top;heading.Controls.Add(status);
            list.Dock=DockStyle.Fill;list.AutoScroll=true;list.Sorted+=MoveCard;
            empty.AutoSize=false;empty.Size=new Size(600,150);empty.TextAlign=ContentAlignment.MiddleCenter;empty.Text="还没有设备\r\n点击右上角「添加设备」，保存后即可连接。";empty.Margin=new Padding(0,30,0,0);
            content.Controls.Add(list);content.Controls.Add(heading);Controls.Add(content);Controls.Add(toolbar);
            toolbar.Add.Click+=delegate{OpenAdd();};
            toolbar.Settings.Click+=delegate{OpenSettings();};
            updates=new UpdateController(root,stateDirectory,isolated,SetUpdateStatus,delegate{exiting=true;Close();},SetUpdateProgress);
            updateCheck.Tick+=delegate{updateCheck.Interval=6*60*60*1000;updates.Check(false);};if(!isolated)updateCheck.Start();
            list.SizeChanged+=delegate{Arrange();};timer.Interval=2000;timer.Tick+=delegate{RefreshState();};timer.Start();
            Deactivate+=delegate{foreach(var card in Cards.Values)card.ClearPointer();};
            ResizeBegin+=delegate{list.Resizing=true;};ResizeEnd+=delegate{list.Resizing=false;Arrange();list.Refresh();};
            FormClosing+=delegate(object sender,FormClosingEventArgs e){if(!exiting&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;if(Options.closeToTray&&!ExitPending)HideToTray();else ExitApplication();}};
            FormClosed+=delegate{timer.Stop();timer.Dispose();updateCheck.Stop();updateCheck.Dispose();updates.Dispose();foreach(var p in children)p.Process.Dispose();};RefreshState();ApplyTheme();EnsureTray();
        }
        internal async void InitializeBackend(Func<bool> initialize,Action<bool> initialized){
            if(backendInitialization!=null||IsDisposed||ExitPending)return;
            BackendStarting=true;notice="正在准备本机连接服务…";RefreshState();
            backendInitialization=Task.Run(initialize);
            bool healthy=false;try{healthy=await backendInitialization;}catch{}
            if(IsDisposed||ExitPending)return;
            BackendStarting=false;
            notice=healthy?"":"本机连接服务未能就绪，请检查日志后重试连接。";
            RefreshState();
            if(initialized!=null)initialized(healthy);
        }
        void ApplyTheme(){
            BackColor=colors.Page;list.BackColor=colors.Page;toolbar.Apply(colors);
            status.ForeColor=colors.Muted;count.ForeColor=empty.ForeColor=colors.Text;
            UpdateView.Apply(colors);
            foreach(var card in Cards.Values){card.Selected=card.Target.Name==selected;card.Apply(colors);}
            if(Editor!=null)Editor.Apply(colors);
            if(Settings!=null)Settings.Apply(colors);
            if(IsHandleCreated)NativeFrame.Apply(Handle,colors);
            Invalidate(true);
        }
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);if(colors!=null)NativeFrame.Apply(Handle,colors);}
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
        float fontScale=1;
        protected override void OnLoad(EventArgs e){try{FollowMonitor((int)GetDpiForWindow(Handle));}catch(EntryPointNotFoundException){}base.OnLoad(e);}
        internal void FollowMonitor(int dpi){
            float next=UiFont.ScaleFor(dpi);UiFont.Scale=next;
            if(Math.Abs(next-fontScale)<0.001f)return;
            float factor=next/fontScale;fontScale=next;
            SuspendLayout();try{UiFont.Rescale(this,factor);}finally{ResumeLayout(false);}
            Arrange();PerformLayout();Invalidate(true);
        }
        protected override bool ProcessCmdKey(ref Message m,Keys keys){
            if(keys==Keys.Tab||keys==(Keys.Shift|Keys.Tab))foreach(var card in Cards.Values)card.BeginKeyboardNavigation();
            return base.ProcessCmdKey(ref m,keys);
        }
        internal void SetTheme(bool dark){try{var next=Options.Copy();next.theme=dark?"dark":"light";ChangeSettings(next);}catch{Error("设置未能保存，请检查本机文件和注册表权限。");}}
        internal void ChangeSettings(AppSettings next){
            bool startupChanged=next.autoStart!=Options.autoStart;
            if(startupChanged&&!isolated)StartupRegistration.Set(Program.ExecutablePath,next.autoStart);
            try{if(!preview)next.Save(stateDirectory);}catch{if(startupChanged&&!isolated)StartupRegistration.Set(Program.ExecutablePath,Options.autoStart);throw;}
            Options=next;Preferences.dark=next.IsDark(Preferences.dark);colors=Palette.Create(Preferences.dark);L.Set(next.language);
            foreach(var card in Cards.Values)card.RefreshTarget(card.Target);RefreshState();ApplyTheme();
        }
        internal void OpenSettings(){if(Editor!=null||Settings!=null)return;editorScroll=ScrollOffset;Turn(1,delegate{Settings=new SettingsPage(Options.Copy(),colors,ChangeSettings,SettingsAction);Settings.AnimateContent=TurnPart;Settings.SetUpdateAvailable(updates.Available,updates.AvailableVersion);Settings.SetUpdateStatus(updates.Status);Settings.SetUpdateProgress(updates.Progress);Settings.BackRequested+=CloseSettings;content.Visible=toolbar.Visible=false;Controls.Add(Settings);Settings.BringToFront();});updates.Check(false);}
        internal void CloseSettings(){if(Settings==null)return;Turn(-1,delegate{var old=Settings;Settings=null;Controls.Remove(old);old.Dispose();content.Visible=toolbar.Visible=true;Arrange();ScrollOffset=editorScroll;});}
        internal SnapshotOverlay Transition;
        internal Control.ControlCollection ContentControls{get{return content.Controls;}}
        internal void FinishTransition(){if(Transition!=null)Transition.Finish();}
        bool CanAnimate{get{return Motion.Enabled&&Visible&&WindowState!=FormWindowState.Minimized&&IsHandleCreated;}}
        void Track(SnapshotOverlay overlay){Transition=overlay;overlay.Finished+=delegate{if(Transition==overlay)Transition=null;};}
        // The swap always runs and always finishes first, so state is final at once; only the picture lags.
        void Turn(int direction,Action swap){Turn(this,ClientRectangle,()=>SnapshotOverlay.CaptureClient(this),direction,swap);}
        void TurnPart(Control part,int direction,Action swap){Turn(part.Parent,part.Bounds,()=>SnapshotOverlay.Snapshot(part),direction,swap);}
        void Turn(Control host,Rectangle bounds,Func<Bitmap> capture,int direction,Action swap){
            FinishTransition();
            if(!CanAnimate){swap();return;}
            SnapshotOverlay overlay=null;
            try{overlay=new SnapshotOverlay(capture(),bounds);host.Controls.Add(overlay);overlay.BringToFront();overlay.Update();}
            catch{if(overlay!=null)overlay.Finish();overlay=null;}
            try{swap();}catch{if(overlay!=null)overlay.Finish();throw;}
            if(overlay==null)return;
            try{overlay.BringToFront();host.PerformLayout();Track(overlay);overlay.PlayFade(capture(),direction);}
            catch{overlay.Finish();}
        }
        bool AnimateExpansion(TargetCard card,bool value){
            FinishTransition();
            if(!CanAnimate||Editor!=null||Settings!=null||!list.Visible||list.Sorting||list.Moving||!card.IsHandleCreated)return false;
            SnapshotOverlay overlay=null;
            try{
                int top=card.Top,before=card.Bottom;
                overlay=new SnapshotOverlay(SnapshotOverlay.Snapshot(list),list.Bounds);content.Controls.Add(overlay);overlay.BringToFront();overlay.Update();
                card.SetExpanded(value,false);Arrange();
                var after=SnapshotOverlay.Snapshot(list);Track(overlay);
                // A shorter list can move the scroll position; then the two pictures no longer line up.
                if(card.Top==top)overlay.PlayReveal(after,value,value?before:card.Bottom,value?card.Bottom:before);
                else overlay.PlayFade(after,0);
                return true;
            }catch{if(overlay!=null)overlay.Finish();return card.Expanded==value;}
        }
        internal void SimulateUpdate(string version){updates.SimulateAvailable(version);}
        void SettingsAction(string name){try{
            if(name=="check"){updates.Check(true);return;}if(name=="update"){RunUpdate();return;}if(name=="uninstall"&&RunUninstall!=null){Uninstall();return;}if(isolated){Settings.SetFeedback("Preview: system actions are disabled.",false);return;}
            if(name=="shortcut"){DesktopShortcut.Create(Program.ExecutablePath,Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));Settings.SetFeedback("快捷方式已创建。",false);}
            else if(name=="program")OpenLocal(root);else if(name=="logs")OpenLocal(stateDirectory);else if(name=="releases")Process.Start(new ProcessStartInfo(UpdateController.ReleaseUrl){UseShellExecute=true});
        }catch{if(Settings!=null)Settings.SetFeedback("操作未完成，请查看本机日志；其他连接不受影响。",true);}}
        void RunUpdate(){if(BackendStarting||ExitPending)return;updateNotice=true;if(children.Count>0){SetUpdateStatus("请先完成或取消正在处理的卡片操作。");return;}updates.Install();}
        void SetUpdateStatus(string message){if(IsDisposed)return;toolbar.SetUpdateDot(updates.Available);if(Settings!=null){Settings.SetUpdateAvailable(updates.Available,updates.AvailableVersion);Settings.SetUpdateStatus(message);}else if(updateNotice&&(updates.Progress==null||!updates.Progress.Visible)){notice=message;status.Text=L.Text(message);}}
        internal void SetUpdateProgress(UpdateProgress value){
            if(IsDisposed)return;
            UpdateView.Set(value);UpdateView.Apply(colors);
            if(Settings!=null)Settings.SetUpdateProgress(value);
        }
        void EnsureTray(){if(tray!=null)return;TrayCommands=new TrayMenu(RefreshState,RestoreManager,ExitApplication,TrayAction,position:trayPosition);tray=new NotifyIcon{Text="CMCP",Icon=Icon,ContextMenuStrip=TrayCommands.ActivationMenu,Visible=!isolated};tray.DoubleClick+=delegate{RestoreManager();};TrayVisible=true;SyncTray();}
        internal void HideToTray(){FinishTransition();EnsureTray();SyncTray();Hide();}
        internal string[] TrayItems {get{return TrayCommands==null?new string[0]:TrayCommands.Menu.Items.OfType<ToolStripMenuItem>().Select(item=>item.Text).ToArray();}}
        TrayTarget TrayValue(TargetCard card){bool blocked=BackendStarting||updates.Installing||ExitPending||children.Any(p=>p.Name==card.Target.Name&&(p.Action=="edit"||p.Action=="remove"));bool active=card.BusyConnect||new[]{"connected","connecting","configuring","waiting-login","recovering","unstable"}.Contains(card.Target.State);return new TrayTarget{Name=card.Target.Name,Label=card.Caption,State=card.SshActive&&card.Target.State=="stopped"&&!card.BusyConnect?"SSH":card.BusyStop?"正在停止":card.BusyConnect&&card.Target.State=="stopped"?"连接中":LocalState.Caption(card.Target.State),CanConnect=!blocked&&!card.BusyStop&&(card.SshActive||!active),CanDisconnect=!blocked&&!card.BusyStop&&(active||card.Target.State!="stopped"),CanRename=!BackendStarting&&!updates.Installing&&!ExitPending&&!IsBusy(card.Target.Name)};}
        void SyncTray(){if(TrayCommands!=null)TrayCommands.Sync(Preferences.Sort(targets).Where(t=>Cards.ContainsKey(t.Name)).Select(t=>TrayValue(Cards[t.Name])).ToList());}
        internal void TrayAction(string name,string action){TargetCard card;if(!Cards.TryGetValue(name,out card))return;var value=TrayValue(card);if(action=="connect"&&value.CanConnect){if(card.SshActive)OpenTerminal(card);else Launch("connect",card,"");}else if(action=="stop"&&value.CanDisconnect)Launch("stop",card,"");else if(action=="rename"&&value.CanRename){RestoreManager();if(Settings!=null)CloseSettings();if(Editor!=null&&Editor.TargetName!=name){Editor.ShowError("请先保存或返回当前编辑页，再重命名其他设备。");return;}OpenEditor(name);if(Editor!=null){Editor.NameInput.Box.Focus();Editor.NameInput.Box.SelectAll();}}SyncTray();}
        async void Uninstall(){
            if(BackendStarting||ExitPending||updates.Installing||children.Count>0){Settings.SetFeedback("请先完成或取消正在处理的卡片操作。",true);return;}
            // An installed copy has its own uninstaller, which asks first and closes this window.
            string uninstaller=FindUninstaller==null?null:FindUninstaller();
            if(uninstaller!=null){try{Process.Start(new ProcessStartInfo(uninstaller){UseShellExecute=true});}catch{Settings.SetFeedback("无法启动卸载程序。",true);}return;}
            if(!ConfirmUninstall())return;
            ExitPending=true;Enabled=false;timer.Stop();Settings.SetFeedback("正在卸载，请稍候...",false);
            int code=-1;try{code=await Task.Run(RunUninstall);}catch{}
            if(IsDisposed)return;
            ExitPending=false;
            // The script already stopped the backend and deleted the state folder, so nothing may run or save again.
            if(code==0||code==2){
                if(!isolated)try{StartupRegistration.Set(Program.ExecutablePath,false);}catch{}
                if(code==2)MessageBox.Show(this,L.Text("本机设置已删除，但有云电脑当时无法连接，上面的 Claude 配置未能移除。"),Text,MessageBoxButtons.OK,MessageBoxIcon.Information);
                exiting=true;Close();return;
            }
            Enabled=true;timer.Start();if(Settings!=null)Settings.SetFeedback("卸载未完成，未删除的内容仍然保留。",true);
        }
        internal async void ExitApplication(){
            if(exiting||ExitPending)return;
            ExitPending=true;Enabled=false;timer.Stop();
            // Cancel only this manager's observers before saving a newer stop-all
            // request, so an old connect action cannot re-enable a target later.
            foreach(var pending in children){pending.Superseded=true;try{if(!pending.Process.HasExited)pending.Process.Kill();}catch{}}
            // Initialization must finish before shutdown, otherwise it can start a
            // new backend after the user's explicit exit has already stopped it.
            if(backendInitialization!=null)try{await backendInitialization;}catch{}
            BackendStarting=false;
            bool stopped=false;try{stopped=isolated?ExitBackend():await Task.Run(()=>ExitBackend());}catch{}
            if(IsDisposed)return;
            ExitPending=false;
            if(stopped){exiting=true;Close();return;}
            Enabled=true;timer.Start();RestoreManager();Error("部分后台进程未能结束，请稍后重试退出；详情已记录到 user\\error.log。");
        }
        internal void RestoreManager(){EnsureTray();Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();}
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window,IntPtr rectangle,IntPtr region,uint flags);
        // A minimized window has no client area. Laying every card out for that and back again on
        // restore, with memory Windows trimmed meanwhile, left the window black until it repainted.
        // So layout waits while minimized, and the restored window paints before anything else runs.
        internal bool LayoutHeld;
        void HoldLayout(){if(!LayoutHeld&&IsIconic(Handle)){LayoutHeld=true;SuspendLayout();}}
        void ReleaseLayout(){if(LayoutHeld&&!IsIconic(Handle)){LayoutHeld=false;ResumeLayout(true);RedrawWindow(Handle,IntPtr.Zero,IntPtr.Zero,0x185);}}
        protected override void WndProc(ref Message message){if(ManagerSignal.Message!=0&&message.Msg==ManagerSignal.Message){RestoreManager();return;}if(ManagerSignal.ExitMessage!=0&&message.Msg==ManagerSignal.ExitMessage){ExitApplication();return;}if(message.Msg==0x2e0)FollowMonitor((int)((long)message.WParam&0xffff));if(message.Msg==0x47)HoldLayout();base.WndProc(ref message);if(message.Msg==0x47)ReleaseLayout();if(message.Msg==0x1a){if(TrayCommands!=null)TrayCommands.ApplySystemTheme();if(Options!=null&&Options.theme=="system"){Preferences.dark=Options.IsDark(Preferences.dark);colors=Palette.Create(Preferences.dark);ApplyTheme();}}}
        protected override void Dispose(bool disposing){if(disposing){TrayVisible=false;if(tray!=null){tray.Visible=false;tray.Dispose();tray=null;}if(TrayCommands!=null){TrayCommands.Dispose();TrayCommands=null;}}base.Dispose(disposing);}
        void SavePreferences(){if(!preview)Preferences.Save(stateDirectory);}
        void Error(string text){notice=text;status.Text=L.Message(text);status.ForeColor=colors.Danger;}
        void OpenLocal(string path){try{if(!File.Exists(path)&&!Directory.Exists(path)){MessageBox.Show(this,L.Text("该位置尚不存在。首次连接后会生成日志。"),Text);return;}Process.Start(new ProcessStartInfo(path){UseShellExecute=true});}catch{Error("无法打开该位置，请检查文件是否存在。");}}
        void Select(TargetCard card){selected=card.Target.Name;foreach(var other in Cards.Values){other.Selected=other==card;other.Apply(colors);}}
        bool IsBusy(string name){return children.Any(p=>p.Name==name&&!p.Superseded);}
        void Launch(string action,TargetCard card,string initialUrl){
            if(BackendStarting||ExitPending)return;
            // A device with only SSH has no connection in the backend at all.
            if(card!=null&&card.Target.Url.Length==0){if(action=="connect"||action=="open")Error("还没有填写共享网页地址，请编辑设备后再连接。");return;}
            if(updates.Installing){Error("正在下载并校验更新…");return;}
            if(preview){if(card!=null&&(action=="connect"||action=="stop")){card.Target.State=action=="connect"?"connected":"stopped";card.Target.Detail=LocalState.Detail(card.Target.State);card.RefreshTarget(card.Target);}return;}
            if(action!="add"&&card==null)return;
            string name=card==null?"":card.Target.Name;
            if(children.Any(p=>p.Name==name&&p.Action==action&&!p.Superseded))return;
            if((action=="edit"||action=="remove")&&IsBusy(name)){Error("此卡片正在处理操作，请完成后重试。");return;}
            if((action=="connect"||action=="stop")&&children.Any(p=>p.Name==name&&(p.Action=="edit"||p.Action=="remove"))){Error("此卡片正在修改，请完成后重试。");return;}
            try{
                var worker=new InlineWorker(kit,action,name,initialUrl,"",false,stateDirectory);
                if(action=="stop")foreach(var old in children.Where(p=>p.Name==name&&p.Action=="connect"))old.Superseded=true;
                children.Add(new PendingAction{Process=worker.Process,Worker=worker,Name=name,Action=action});
                if(card!=null){card.SetExpanded(true,false);progress[name]=action=="stop"?"正在取消此台连接…":action=="open"?"正在打开此台云电脑…":"正在准备连接…";}
                notice="";RefreshState();
            }catch{Error("操作未能启动，请确认便携包完整且 Windows PowerShell 可用。");}
        }
        void ConnectCard(TargetCard card){Select(card);if(card.SshActive){OpenTerminal(card);return;}bool active=card.Target.State=="connected"||card.BusyConnect||card.Target.State=="connecting"||card.Target.State=="configuring"||card.Target.State=="waiting-login"||card.Target.State=="recovering"||card.Target.State=="unstable";if(active)StopCard(card);else Launch("connect",card,"");}
        void StopCard(TargetCard card){if(card.SshActive)StopSsh(card);else Launch("stop",card,"");}
        // Stops the background channel of this device. Its terminal windows stay unless the
        // settings ask to close them; then the ssh inside each one ends and the window closes.
        void StopSsh(TargetCard card){
            Select(card);string name=card.Target.Name;
            if(card.SshState.Length==0||!sshStopping.Add(name))return;
            card.SshStopping=true;card.UpdateActions();
            bool closeTerminals=Options.closeTerminal;
            // Back on this window's thread by name: the worker's answer must never touch a control from the pool.
            Task.Run(()=>{
                bool stopped=false;try{stopped=StopSshWorker(stateDirectory,name);}catch{}
                if(closeTerminals)try{CloseSshSessions(stateDirectory,name);}catch{}
                try{BeginInvoke(new Action(()=>SshStopFinished(card,name,stopped,closeTerminals)));}catch(InvalidOperationException){}
            });
        }
        void SshStopFinished(TargetCard card,string name,bool stopped,bool closedTerminals){
            if(IsDisposed)return;
            if(stopped){notice=closedTerminals?"SSH 通道已停止，终端窗口已关闭。":"SSH 通道已停止；已打开的终端窗口不受影响。";status.Text=L.Text(notice);}
            else{sshStopping.Remove(name);card.SshStopping=false;Error("无法停止 SSH 通道，请稍后重试。");}
            RefreshState();
        }
        int ConnectedDevices(){TargetCard card;return targets.Count(t=>t.State=="connected"||(Cards.TryGetValue(t.Name,out card)&&card.SshState=="ready"));}
        internal void OpenAdd(){
            if(BackendStarting||ExitPending)return;
            if(Editor!=null||Settings!=null)return;editorScroll=ScrollOffset;
            ShowEditor(new Target{Name="",Url=""},new CardPreference());
        }
        void ShowEditor(Target target,CardPreference preference){
            Turn(1,delegate{
                Editor=new TargetEditorPage(target,preference,colors,Ssh.Get(target.Name));Editor.AnimateContent=TurnPart;
                Editor.BackRequested+=CloseEditor;Editor.SaveRequested+=SaveEditor;
                content.Visible=false;toolbar.Visible=false;Controls.Add(Editor);Editor.BringToFront();ActiveControl=null;
            });
        }
        void EditCard(TargetCard card){OpenEditor(card.Target.Name);}
        internal void OpenEditor(string name){
            if(BackendStarting||ExitPending)return;
            TargetCard card;if(Editor!=null||Settings!=null||!Cards.TryGetValue(name,out card))return;
            Select(card);editorScroll=ScrollOffset;
            ShowEditor(card.Target,card.Preference);
        }
        internal void CloseEditor(){
            if(Editor==null)return;
            if(!Editor.Save.Enabled){Editor.ShowError("正在保存，请等待本页校验完成。");return;}
            Turn(-1,delegate{
                var previous=Editor;Editor=null;Controls.Remove(previous);previous.Dispose();
                content.Visible=true;toolbar.Visible=true;Arrange();ScrollOffset=editorScroll;
                foreach(var card in Cards.Values)card.ClearPointer();
            });
        }
        void SaveEditor(){
            Mark("editor-save begin");
            if(Editor==null)return;
            var editor=Editor;
            if(editor.IsNew){if(editor.HasWeb)SaveConnection(editor,null);else SaveSshOnly(editor,null);return;}
            TargetCard card;if(!Cards.TryGetValue(editor.TargetName,out card)){editor.ShowError("所选设备已不存在，请返回列表。");return;}
            if(IsBusy(card.Target.Name)){editor.ShowError("此设备正在处理操作，请完成后重试。");return;}
            bool hadWeb=card.Target.Url.Length>0;
            if(!hadWeb){if(editor.HasWeb)SaveConnection(editor,card);else SaveSshOnly(editor,card);return;}
            if(!editor.HasWeb){
                if(card.Target.State!="stopped"){editor.ShowError("请先停止此连接，再删除共享网页登录。");return;}
                // The address leaves the backend; the same card goes on as an SSH-only device.
                if(!SaveSshOnly(editor,card))return;
                if(preview){card.Target.Url="";card.Target.Mode="SSH";RefreshState();}else Launch("remove",card,"");
                return;
            }
            bool changed=!String.Equals(editor.Url.TrimEnd('/'),card.Target.Url,StringComparison.OrdinalIgnoreCase);
            bool authChanged=editor.AutoLogin!=card.Target.AutoLogin;
            if((changed||editor.Password.Length>0||authChanged)&&card.Target.State!="stopped"){editor.ShowError("请先停止此连接，再修改地址、密码或自动登录；备注和图标可随时修改。");return;}
            if(changed&&targets.Any(t=>t.Name!=card.Target.Name&&String.Equals(t.Url,editor.Url.TrimEnd('/'),StringComparison.OrdinalIgnoreCase))){editor.ShowError("该地址已经添加，未覆盖其他设备。");return;}
            if(changed||editor.Password.Length>0||authChanged){SaveConnection(editor,card);return;}
            try{
                string name=card.Target.Name,url=editor.Url;
                var login=editor.BuildSsh(name);if(login!=null){Ssh.Put(login);SaveSsh();}else if(Ssh.Remove(name))SaveSsh();card.Ssh=login;
                Preferences.Set(name,editor.DisplayName,editor.IconData,targets,editor.Note,editor.HideAddress.Checked);SavePreferences();Mark("editor-save preferences saved");card.UpdatePreference(Preferences.Get(name));Mark("editor-save card presentation updated");
                CloseEditor();Mark("editor-save returned to list");if(changed)Launch("edit",Cards[name],url);RefreshState();Mark("editor-save complete");
            }catch{if(Editor!=null)Editor.ShowError("无法保存界面偏好，未更改连接信息。");else Error("无法保存界面偏好，未更改连接信息。");}
        }
        void SaveConnection(TargetEditorPage editor,TargetCard card){
            if(preview){editor.ShowError("此预览不会访问网络或保存连接；请使用主程序添加。");return;}
            if(children.Any(p=>p.Action=="add"||p.Action=="edit")){editor.ShowError("正在校验另一项保存，请稍后重试。");return;}
            try{
                // A device that had only SSH gets its first address, so the backend sees a new target.
                bool add=card==null||card.Target.Url.Length==0;
                var draft=editor.BuildSsh("");
                var worker=new InlineWorker(kit,add?"add":"edit",add?"":editor.TargetName,editor.Url,editor.Password,editor.AutoLogin);
                children.Add(new PendingAction{Worker=worker,Process=worker.Process,Name=editor.TargetName,Action=add?"add":"edit",Label=editor.DisplayName,Icon=editor.IconData,Note=editor.Note,HideAddress=editor.HideAddress.Checked,SshDraft=draft,DropSsh=draft==null,LoginMode=card==null?"":card.Preference.loginMode,SshFrom=card!=null&&add?card.Target.Name:""});
                editor.PasswordInput.Box.Clear();editor.SetBusy(true);editor.ShowError("正在校验地址和登录协议…");
            }catch{editor.ShowError("无法启动校验，请确认便携包完整。");}
        }
        bool SaveSshOnly(TargetEditorPage editor,TargetCard card){
            if(card==null&&targets.Count>=100){editor.ShowError("最多保存 100 台设备。");return false;}
            string name=card!=null?card.Target.Name:"ssh-"+Guid.NewGuid().ToString("N").Substring(0,12);
            try{
                var login=editor.BuildSsh(name);
                if(login!=null){Ssh.Put(login);SaveSsh();}
                Preferences.Set(name,editor.DisplayName,editor.IconData,WithSshOnly(targets),editor.Note,editor.HideAddress.Checked);SavePreferences();
                if(card!=null){card.Ssh=login;card.UpdatePreference(Preferences.Get(name));}
            }catch{editor.ShowError("无法保存 SSH 信息，未更改其他内容。");return false;}
            CloseEditor();RefreshState();return true;
        }
        void SaveSsh(){if(!preview)Ssh.Save(stateDirectory);}
        static Target SshOnlyTarget(string name){return new Target{Name=name,Url="",Mode="SSH",State="stopped",Detail=""};}
        // The backend never hears of these devices; only this window lists them.
        List<Target> WithSshOnly(IEnumerable<Target> known){
            var merged=known.ToList();
            foreach(var login in Ssh.logins)if(!merged.Any(t=>t.Name==login.name)&&!children.Any(p=>p.DeleteSsh&&p.Name==login.name))merged.Add(SshOnlyTarget(login.name));
            return merged;
        }
        void ApplySshAfterSave(PendingAction pending,string name){
            try{
                bool changed=false;
                if(pending.SshFrom.Length>0&&pending.SshFrom!=name)changed|=Ssh.Remove(pending.SshFrom);
                if(pending.DropSsh)changed|=Ssh.Remove(name);else if(pending.SshDraft!=null){pending.SshDraft.name=name;Ssh.Put(pending.SshDraft);changed=true;}
                if(changed)SaveSsh();
            }catch{Error("地址已保存，但 SSH 信息保存失败，请稍后编辑。");}
        }
        internal void SwitchLogin(TargetCard card){
            Select(card);string name=card.Target.Name,mode=card.SshActive?"web":"ssh",previous=card.Preference.loginMode;
            var before=Preferences.cards.ToList();
            try{
                Preferences.cards=Preferences.Sort(targets).Select(t=>Preferences.Get(t.Name)).ToList();
                Preferences.Set(name,card.Preference.label,card.Preference.icon,targets,card.Preference.note);
                var next=Preferences.Get(name);TurnPart(card,mode=="ssh"?1:-1,delegate{next.loginMode=mode;SavePreferences();card.UpdatePreference(next);});
            }catch{Preferences.Get(name).loginMode=previous;Preferences.cards=before;card.UpdatePreference(Preferences.Get(name));Error("无法保存登录方式，请重试。");}
            card.PerformLayout();SyncTray();
        }
        internal void OpenTerminal(TargetCard card){
            Select(card);var login=card.Ssh;if(login==null){Error("还没有填写 SSH 信息，请编辑设备后再连接。");return;}
            if(preview){notice="预览不会打开终端。";status.Text=L.Text(notice);return;}
            var terminal=Terminals.Resolve(Options.terminal,Terminals.Detect());
            string ssh=SshCommand.FindSsh();
            if(terminal==null||(terminal.Id!="gitbash"&&ssh==null)){Error("未找到 ssh。请在 Windows 设置的“可选功能”中安装 OpenSSH 客户端。");return;}
            try{
                var mcp=new SshCommand.McpLaunch{Node=Path.Combine(kit,"runtime","node.exe"),Script=Path.Combine(kit,"ssh-terminal.mjs"),Directory=stateDirectory,Owner=Process.GetCurrentProcess().Id};
                StartTerminal(SshCommand.Start(terminal,login,ssh,Program.ExecutablePath,mcp,Options.closeTerminal?SshSessions.Folder(stateDirectory,login.name):null));
                notice=L.Text("已打开终端")+" · "+login.Address;status.Text=notice;
            }catch{Error("无法打开所选终端，请在设置中换一个终端后重试。");}
        }
        static SshStore DemoSsh(){var demo=new SshStore();demo.logins.Add(new SshLogin{name="preview-b",host="203.0.113.24",username="root"});return demo;}
        void CollectActions(){
            foreach(var pending in children.ToArray()){
                bool exited=false;try{exited=pending.Process.HasExited;if(exited)pending.Process.WaitForExit();}catch{exited=true;}
                if(pending.Worker!=null)foreach(var data in pending.Worker.Drain()){
                    if(pending.Superseded)continue;
                    string kind=LocalState.Text(LocalState.Get(data,"kind")),message=LocalState.Text(LocalState.Get(data,"message"));
                    pending.Message=message;pending.Failed|=kind=="error";
                    if(pending.Action=="add"||pending.Action=="edit"){
                        if(Editor!=null&&Editor.TargetName==pending.Name)Editor.ShowError(message);
                        if(kind=="saved"){
                            string name=LocalState.Text(LocalState.Get(data,"name"));
                            var saved=LocalState.Load(stateDirectory).Targets;
                            if(!saved.Any(t=>t.Name==name)){pending.Failed=true;continue;}
                            ApplySshAfterSave(pending,name);Preferences.Set(name,pending.Label,pending.Icon,WithSshOnly(saved),pending.Note,pending.HideAddress);Preferences.Get(name).loginMode=pending.LoginMode;
                            try{SavePreferences();pending.Saved=true;TargetCard card;if(Cards.TryGetValue(name,out card)){card.Ssh=Ssh.Get(name);card.UpdatePreference(Preferences.Get(name));}}
                            catch{Error("地址已保存，但备注或图标保存失败，请稍后编辑。");pending.Saved=true;}
                        }
                    }else progress[pending.Name]=message;
                }
                try{if(!exited)continue;
                    if(pending.Action=="remove"&&pending.DeleteSsh&&pending.Process.ExitCode==0&&Ssh.Remove(pending.Name))try{SaveSsh();}catch{}
                    if(!pending.Superseded){
                        if(pending.Action=="add"||pending.Action=="edit"){
                            if(pending.Saved){if(Editor!=null)Editor.SetBusy(false);CloseEditor();}
                            else if(Editor!=null){Editor.SetBusy(false);Editor.ShowError(pending.Message.Length>0?pending.Message:"保存未完成，请检查本机日志。");}
                        }else if(pending.Process.ExitCode!=0&&!pending.Failed&&pending.Message.Length==0)progress[pending.Name]="操作未完成，请查看本机日志；其他连接不受影响。";
                        else if(pending.Action=="stop"&&pending.Process.ExitCode==0)progress[pending.Name]="此台连接已停止。";
                        else if(pending.Action=="open"&&pending.Process.ExitCode==0)progress[pending.Name]="已打开此台云电脑。";
                        else if(pending.Action=="connect"&&pending.Process.ExitCode==0&&!pending.Failed)progress.Remove(pending.Name);
                    }
                }catch{}
                pending.Process.Dispose();children.Remove(pending);
            }
        }
        void DeleteCard(TargetCard card){Select(card);if(preview){Ssh.Remove(card.Target.Name);targets.Remove(card.Target);Cards.Remove(card.Target.Name);list.Controls.Remove(card);card.Dispose();Arrange();return;}if(MessageBox.Show(this,(L.Language=="en"?"Remove this device and stop its connection?\r\n":"删除这台设备的本地配置并停止它的连接？\r\n")+(card.Target.Url.Length>0?card.Target.Url:card.Ssh!=null?card.Ssh.Address:"")+(L.Language=="en"?"\r\nVPS and local files are preserved. Other connections remain unchanged.":"\r\n不会删除 VPS 或本机文件，其他连接保持不变。"),L.Text("删除设备"),MessageBoxButtons.OKCancel,MessageBoxIcon.Warning)==DialogResult.OK){
            if(card.Target.Url.Length==0){Ssh.Remove(card.Target.Name);try{SaveSsh();}catch{Error("无法保存 SSH 信息，未更改其他内容。");}targets.Remove(card.Target);RefreshState();return;}
            Launch("remove",card,"");foreach(var pending in children.Where(p=>p.Name==card.Target.Name&&p.Action=="remove"))pending.DeleteSsh=true;}}
        void CopyCard(TargetCard card){if(card.SshActive?card.Ssh==null:card.Target.Url.Length==0)return;try{Clipboard.SetText(card.Address);notice="地址已复制（不包含登录凭据）";status.Text=L.Text(notice);}catch{Error("剪贴板暂时不可用，请稍后重试。");}}
        TargetCard CreateCard(Target target){var card=new TargetCard(target,Preferences.Get(target.Name)){Margin=new Padding(0,0,0,Palette.Gap),Font=Font};card.SelectedCard+=Select;card.SwitchRequested+=SwitchLogin;card.ConnectRequested+=ConnectCard;card.StopRequested+=StopCard;card.EditRequested+=EditCard;card.DeleteRequested+=DeleteCard;card.CopyRequested+=CopyCard;card.OpenRequested+=delegate(TargetCard c){Select(c);if(c.SshActive)OpenTerminal(c);else Launch("open",c,"");};card.LogsRequested+=delegate{if(!preview)OpenLocal(stateDirectory);};card.MoveRequested+=MoveByKeyboard;card.AnimateExpansion=AnimateExpansion;card.SizeChanged+=delegate{Arrange();};
            card.DragEnter+=delegate(object sender,DragEventArgs e){e.Effect=CanDrop(e)?DragDropEffects.Move:DragDropEffects.None;};card.DragOver+=delegate(object sender,DragEventArgs e){e.Effect=CanDrop(e)?DragDropEffects.Move:DragDropEffects.None;};card.DragDrop+=delegate(object sender,DragEventArgs e){if(CanDrop(e))DropMove((string)e.Data.GetData(typeof(string)),card.Target.Name,card.PointToClient(new Point(e.X,e.Y)).Y>card.Height/2);};return card;}
        bool CanDrop(DragEventArgs e){return e.Data.GetDataPresent(typeof(string))&&Cards.ContainsKey((string)e.Data.GetData(typeof(string)));}
        internal void MoveCard(string from,string before){try{Preferences.Move(from,before,targets);SavePreferences();Arrange(true);}catch{Error("排序未能保存，请检查界面偏好文件。");}}
        internal void DropMove(string from,string hit,bool after){if(from==hit)return;var ordered=Preferences.Sort(targets).Where(t=>t.Name!=from).ToList();int index=ordered.FindIndex(t=>t.Name==hit);if(index<0)return;MoveCard(from,after?(index+1<ordered.Count?ordered[index+1].Name:""):hit);}
        void MoveByKeyboard(TargetCard card,int direction){var ordered=Preferences.Sort(targets);int index=ordered.FindIndex(t=>t.Name==card.Target.Name);if(index+direction<0||index+direction>=ordered.Count)return;MoveCard(card.Target.Name,direction<0?ordered[index-1].Name:index+2<ordered.Count?ordered[index+2].Name:"");}
        internal void RefreshState(){
            CollectActions();
            var snapshot=preview?new Snapshot{Running=true,Targets=!previewInitialized?Demo().Targets:targets}:LocalState.Load(stateDirectory);targets=WithSshOnly(snapshot.Targets);previewInitialized=true;
            count.Text="设备  ·  "+targets.Count;
            status.Text=notice.Length>0?notice:preview?"交互预览 · 示例数据，不会连接 VPS":snapshot.ReadError?"本地状态暂时无法完整读取，将自动刷新":Preferences.ReadError?"界面偏好文件无法读取，已保留原文件":Ssh.ReadError?"SSH 配置文件无法读取，已保留原文件":snapshot.Stale?"后台状态未更新，请检查连接":snapshot.Running?ConnectedDevices()+" 台已连接 · 每台设备独立控制":"后台尚未运行 · 打开界面不会自动连接";
            if(L.Language=="en"){count.Text="Devices  ·  "+targets.Count;status.Text=snapshot.Running&&notice.Length==0&&!preview&&!snapshot.ReadError&&!snapshot.Stale?ConnectedDevices()+" connected · Each PC is controlled independently":L.Message(status.Text);empty.Text="No devices yet\r\nAdd a device to get started.";}else empty.Text="还没有设备\r\n点击右上角「添加设备」，保存后即可连接。";
            toolbar.Enabled=list.Enabled=!BackendStarting;
            foreach(var key in Cards.Keys.Where(key=>!targets.Any(t=>t.Name==key)).ToArray()){var old=Cards[key];Cards.Remove(key);list.Controls.Remove(old);old.Dispose();}
            if(!targets.Any(t=>t.Name==selected))selected=targets.Count>0?targets[0].Name:"";
            foreach(var target in targets){TargetCard card;if(!Cards.TryGetValue(target.Name,out card)){card=CreateCard(target);Cards.Add(target.Name,card);list.Controls.Add(card);}
                card.Ssh=Ssh.Get(target.Name);
                string channel=card.Ssh==null?"":preview&&ReadSshState==SshWorkers.State?"":ReadSshState(stateDirectory,target.Name);if(channel!=null)card.SshState=channel;
                if(card.SshState.Length==0)sshStopping.Remove(target.Name);card.SshStopping=sshStopping.Contains(target.Name);
                card.BusyConnect=children.Any(p=>p.Name==target.Name&&p.Action=="connect"&&!p.Superseded);card.BusyStop=children.Any(p=>p.Name==target.Name&&(p.Action=="stop"||p.Action=="remove"));
                string message;if(progress.TryGetValue(target.Name,out message)){
                    target.Detail=LocalState.WorkerDetail(target,message,card.BusyConnect);
                }
                if(target.AutoLogin&&(target.State=="password"||target.State=="locked"||target.State=="expired"))target.Detail=LocalState.Detail(target.State);
                card.RefreshTarget(target);card.Edit.Enabled=card.Delete.Enabled=!IsBusy(target.Name);
            }
            toolbar.Add.Enabled=!children.Any(p=>p.Action=="add"||p.Action=="edit"||p.Action=="remove");Arrange();ApplyTheme();SyncTray();
        }
        void Arrange(){Arrange(false);}
        void Arrange(bool animate){if(arranging||IsDisposed)return;arranging=true;try{
            if(Cards.Count==0){if(!list.Controls.Contains(empty))list.Controls.Add(empty);empty.Visible=true;empty.Width=Math.Max(100,list.ClientSize.Width-22);}
            else{list.Controls.Remove(empty);list.Place(Preferences.Sort(targets).Where(t=>Cards.ContainsKey(t.Name)&&Cards[t.Name].Parent==list).Select(t=>Cards[t.Name]).ToList(),animate);}
        }finally{arranging=false;}}

        internal bool TestIndependentButtons(){if(Cards.Count!=2)return false;var cards=Cards.Values.ToArray();var process=Process.GetCurrentProcess();var pending=new PendingAction{Process=process,Name=cards[0].Target.Name,Action="connect"};try{children.Add(pending);RefreshState();return cards[0].BusyConnect&&cards[0].Details.Stop.Enabled&&!cards[0].Edit.Enabled&&!cards[1].BusyConnect&&cards[1].Edit.Enabled&&cards[1].Details.Open.Enabled;}finally{children.Remove(pending);process.Dispose();RefreshState();}}
        internal bool LayoutFits(){return (Editor==null||Editor.LayoutFits)&&Cards.Values.All(c=>c.Right<=list.ClientSize.Width&&c.Connect.Left>=40&&c.Delete.Right<c.Width&&c.Details.Open.Right<c.Details.Width&&c.Details.Logs.Right<c.Details.Width)&&toolbar.Add.Right<=toolbar.ClientSize.Width&&toolbar.Add.Left>toolbar.Settings.Right;}
        internal int ScrollOffset { get { return -list.AutoScrollPosition.Y; } set { list.AutoScrollPosition=new Point(0,value); } }
        internal static Snapshot Demo(){var s=new Snapshot{Running=true};s.Targets.Add(new Target{Name="preview-a",Url="https://desktop1.example.com",Mode="共享网页登录",State="connected",DesktopClient=true,CliClient=false,Detail=LocalState.Detail("connected")});s.Targets.Add(new Target{Name="preview-b",Url="https://desktop2.example.com",Mode="共享网页登录",State="stopped",Detail=LocalState.Detail("stopped")});return s;}
    }
}
