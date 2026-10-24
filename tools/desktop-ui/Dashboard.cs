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
        readonly string stateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeLocalMcp");
        readonly bool preview;
        readonly DashboardToolbar toolbar = new DashboardToolbar();
        internal readonly CardList list = new CardList();
        readonly Label status = new Label(), count = new Label(), empty = new Label();
        readonly Panel content = new Panel();
        internal TargetEditorPage Editor;
        internal SettingsPage Settings;
        internal AppSettings Options;
        readonly bool isolated;
        NotifyIcon tray;
        internal bool TrayVisible;
        bool exiting,updateNotice;
        internal bool ExitPending;
        internal Func<bool> ExitBackend;
        UpdateController updates;
        internal Action<string> Trace;
        void Mark(string message){if(Trace!=null)Trace(message);}
        int editorScroll;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        sealed class PendingAction { internal Process Process; internal InlineWorker Worker; internal string Name, Action, Label="", Icon="", Message=""; internal bool Superseded, Failed, Saved; }
        readonly Dictionary<string,string> progress=new Dictionary<string,string>();
        readonly List<PendingAction> children = new List<PendingAction>();
        internal readonly Dictionary<string,TargetCard> Cards = new Dictionary<string,TargetCard>(StringComparer.Ordinal);
        internal UiPreferences Preferences;
        Palette colors;
        List<Target> targets = new List<Target>();
        string selected = "", notice = "";
        bool arranging, previewInitialized;
        internal Manager(bool demo, string stateOverride = null, string kitOverride = null) {
            if (stateOverride != null) stateDirectory = stateOverride;
            if (kitOverride != null) kit = kitOverride;
            preview = demo;isolated=demo||stateOverride!=null; Preferences = demo ? new UiPreferences() : UiPreferences.Load(stateDirectory);
            ExitBackend=isolated?(Func<bool>)(()=>true):(()=>BackendRestart.Run(kit,"manager-exit.ps1"));
            Options=demo?new AppSettings():AppSettings.Load(stateDirectory,!isolated&&StartupRegistration.Enabled());L.Set(Options.language);Preferences.dark=Options.IsDark(Preferences.dark);if(Options.theme.Length==0)Options.theme=Preferences.dark?"dark":"light";
            colors=Palette.Create(Preferences.dark);Text="CMCP";
            Icon=System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font=new Font("Microsoft YaHei UI",11F);AutoScaleMode=AutoScaleMode.Dpi;
            DoubleBuffered=true;SetStyle(ControlStyles.ResizeRedraw,true);
            ClientSize=new Size(1100,720);MinimumSize=new Size(660,500);StartPosition=FormStartPosition.CenterScreen;
            content.Dock=DockStyle.Fill;content.Padding=new Padding(28,10,28,0);
            var heading = new Panel { Dock=DockStyle.Top, Height=66 };
            count.Bounds=new Rectangle(0,2,400,28);count.Font=new Font(Font.FontFamily,12F,FontStyle.Bold);heading.Controls.Add(count);
            status.Bounds=new Rectangle(0,34,850,24);status.Anchor=AnchorStyles.Left|AnchorStyles.Right|AnchorStyles.Top;heading.Controls.Add(status);
            list.Dock=DockStyle.Fill;list.AutoScroll=true;list.Sorted+=MoveCard;
            empty.AutoSize=false;empty.Size=new Size(600,150);empty.TextAlign=ContentAlignment.MiddleCenter;empty.Text="还没有云电脑\r\n点击右上角「添加云电脑」，保存地址后即可连接。";empty.Margin=new Padding(0,30,0,0);
            content.Controls.Add(list);content.Controls.Add(heading);Controls.Add(content);Controls.Add(toolbar);
            toolbar.Add.Click+=delegate{OpenAdd();};toolbar.Theme.Click+=delegate{SetTheme(!Preferences.dark);};
            toolbar.Settings.Click+=delegate{OpenSettings();};
            updates=new UpdateController(root,stateDirectory,isolated,SetUpdateStatus,delegate{exiting=true;Close();});
            toolbar.UpdateButton.MouseEnter+=delegate{updates.Check(false);};toolbar.UpdateButton.Click+=delegate{RunUpdate();};
            list.SizeChanged+=delegate{Arrange();};timer.Interval=2000;timer.Tick+=delegate{RefreshState();};timer.Start();
            Deactivate+=delegate{foreach(var card in Cards.Values)card.ClearPointer();};
            ResizeBegin+=delegate{list.Resizing=true;};ResizeEnd+=delegate{list.Resizing=false;Arrange();list.Refresh();};
            FormClosing+=delegate(object sender,FormClosingEventArgs e){if(!exiting&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;if(Options.closeToTray&&!ExitPending)HideToTray();else ExitApplication();}};
            FormClosed+=delegate{timer.Stop();timer.Dispose();updates.Dispose();if(tray!=null)tray.Dispose();foreach(var p in children)p.Process.Dispose();};RefreshState();ApplyTheme();
        }
        void ApplyTheme(){
            BackColor=colors.Page;list.BackColor=colors.Page;toolbar.Apply(colors);
            status.ForeColor=colors.Muted;count.ForeColor=empty.ForeColor=colors.Text;
            foreach(var card in Cards.Values){card.Selected=card.Target.Name==selected;card.Apply(colors);}
            if(Editor!=null)Editor.Apply(colors);
            if(Settings!=null)Settings.Apply(colors);
            if(IsHandleCreated)NativeFrame.Apply(Handle,colors);
            Invalidate(true);
        }
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);if(colors!=null)NativeFrame.Apply(Handle,colors);}
        protected override bool ProcessCmdKey(ref Message m,Keys keys){
            if(keys==Keys.Tab||keys==(Keys.Shift|Keys.Tab))foreach(var card in Cards.Values)card.BeginKeyboardNavigation();
            return base.ProcessCmdKey(ref m,keys);
        }
        internal void SetTheme(bool dark){try{var next=Options.Copy();next.theme=dark?"dark":"light";ChangeSettings(next);}catch{Error("设置未能保存，请检查本机文件和注册表权限。");}}
        internal void ChangeSettings(AppSettings next){
            bool startupChanged=next.autoStart!=Options.autoStart;
            if(startupChanged&&!isolated)StartupRegistration.Set(Application.ExecutablePath,next.autoStart);
            try{if(!preview)next.Save(stateDirectory);}catch{if(startupChanged&&!isolated)StartupRegistration.Set(Application.ExecutablePath,Options.autoStart);throw;}
            Options=next;Preferences.dark=next.IsDark(Preferences.dark);colors=Palette.Create(Preferences.dark);L.Set(next.language);
            foreach(var card in Cards.Values)card.RefreshTarget(card.Target);RefreshState();ApplyTheme();
        }
        internal void OpenSettings(){if(Editor!=null||Settings!=null)return;editorScroll=ScrollOffset;Settings=new SettingsPage(Options.Copy(),colors,ChangeSettings,SettingsAction);Settings.SetUpdateStatus(updates.Status);Settings.BackRequested+=CloseSettings;content.Visible=toolbar.Visible=false;Controls.Add(Settings);Settings.BringToFront();}
        internal void CloseSettings(){if(Settings==null)return;var old=Settings;Settings=null;Controls.Remove(old);old.Dispose();content.Visible=toolbar.Visible=true;Arrange();ScrollOffset=editorScroll;}
        void SettingsAction(string name){try{
            if(name=="update"){RunUpdate();return;}if(isolated){Settings.SetFeedback("Preview: system actions are disabled.",false);return;}
            if(name=="shortcut"){DesktopShortcut.Create(Application.ExecutablePath,Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));Settings.SetFeedback("快捷方式已创建。",false);}
            else if(name=="program")OpenLocal(root);else if(name=="logs")OpenLocal(stateDirectory);else if(name=="releases")Process.Start(new ProcessStartInfo(UpdateController.ReleaseUrl){UseShellExecute=true});
        }catch{if(Settings!=null)Settings.SetFeedback("操作未完成，请查看本机日志；其他连接不受影响。",true);}}
        void RunUpdate(){updateNotice=true;if(children.Count>0){SetUpdateStatus("请先完成或取消正在处理的卡片操作。");return;}updates.Install();}
        void SetUpdateStatus(string message){if(IsDisposed)return;toolbar.UpdateTip(message);if(Settings!=null)Settings.SetUpdateStatus(message);else if(updateNotice){notice=message;status.Text=L.Text(message);}}
        internal void HideToTray(){
            if(tray==null){var menu=new ContextMenuStrip();menu.Items.Add(L.Text("打开主界面"),null,delegate{RestoreManager();});menu.Items.Add(L.Text("退出程序"),null,delegate{ExitApplication();});tray=new NotifyIcon{Text="CMCP",Icon=Icon,ContextMenuStrip=menu};tray.DoubleClick+=delegate{RestoreManager();};}
            TrayVisible=true;if(tray!=null){tray.ContextMenuStrip.Items[0].Text=L.Text("打开主界面");tray.ContextMenuStrip.Items[1].Text=L.Text("退出程序");tray.Visible=!isolated;}Hide();
        }
        internal string[] TrayItems {get{return tray==null?new string[0]:tray.ContextMenuStrip.Items.Cast<ToolStripItem>().Select(item=>item.Text).ToArray();}}
        internal async void ExitApplication(){
            if(exiting||ExitPending)return;
            ExitPending=true;Enabled=false;timer.Stop();
            // Cancel only this manager's observers before saving a newer stop-all
            // request, so an old connect action cannot re-enable a target later.
            foreach(var pending in children){pending.Superseded=true;try{if(!pending.Process.HasExited)pending.Process.Kill();}catch{}}
            bool stopped=false;try{stopped=isolated?ExitBackend():await Task.Run(()=>ExitBackend());}catch{}
            if(IsDisposed)return;
            ExitPending=false;
            if(stopped){exiting=true;Close();return;}
            Enabled=true;timer.Start();RestoreManager();Error("未能确认全部连接已断开，请稍后重试退出。");
        }
        internal void RestoreManager(){TrayVisible=false;if(tray!=null)tray.Visible=false;Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();}
        protected override void WndProc(ref Message message){if(ManagerSignal.Message!=0&&message.Msg==ManagerSignal.Message){RestoreManager();return;}base.WndProc(ref message);if(message.Msg==0x1a&&Options!=null&&Options.theme=="system"){Preferences.dark=Options.IsDark(Preferences.dark);colors=Palette.Create(Preferences.dark);ApplyTheme();}}
        void SavePreferences(){if(!preview)Preferences.Save(stateDirectory);}
        void Error(string text){notice=text;status.Text=L.Message(text);status.ForeColor=colors.Danger;}
        void OpenLocal(string path){try{if(!File.Exists(path)&&!Directory.Exists(path)){MessageBox.Show(this,L.Text("该位置尚不存在。首次连接后会生成日志。"),Text);return;}Process.Start(new ProcessStartInfo(path){UseShellExecute=true});}catch{Error("无法打开该位置，请检查文件是否存在。");}}
        void Select(TargetCard card){selected=card.Target.Name;foreach(var other in Cards.Values){other.Selected=other==card;other.Apply(colors);}}
        bool IsBusy(string name){return children.Any(p=>p.Name==name&&!p.Superseded);}
        void Launch(string action,TargetCard card,string initialUrl){
            if(updates.Installing){Error("正在下载并校验更新…");return;}
            if(preview){if(card!=null&&(action=="connect"||action=="stop")){card.Target.State=action=="connect"?"connected":"stopped";card.Target.Detail=LocalState.Detail(card.Target.State);card.RefreshTarget(card.Target);}return;}
            if(action!="add"&&card==null)return;
            string name=card==null?"":card.Target.Name;
            if(children.Any(p=>p.Name==name&&p.Action==action&&!p.Superseded))return;
            if((action=="edit"||action=="remove")&&IsBusy(name)){Error("此卡片正在处理操作，请完成后重试。");return;}
            if((action=="connect"||action=="stop")&&children.Any(p=>p.Name==name&&(p.Action=="edit"||p.Action=="remove"))){Error("此卡片正在修改，请完成后重试。");return;}
            try{
                var worker=new InlineWorker(kit,action,name,initialUrl,"");
                if(action=="stop")foreach(var old in children.Where(p=>p.Name==name&&p.Action=="connect"))old.Superseded=true;
                children.Add(new PendingAction{Process=worker.Process,Worker=worker,Name=name,Action=action});
                if(card!=null){card.SetExpanded(true,false);progress[name]=action=="stop"?"正在取消此台连接…":action=="open"?"正在打开此台云电脑…":"正在准备连接…";}
                notice="";RefreshState();
            }catch{Error("操作未能启动，请确认便携包完整且 Windows PowerShell 可用。");}
        }
        void ConnectCard(TargetCard card){Select(card);bool active=card.Target.State=="connected"||card.BusyConnect||card.Target.State=="connecting"||card.Target.State=="configuring"||card.Target.State=="waiting-login";if(active)StopCard(card);else Launch("connect",card,"");}
        void StopCard(TargetCard card){Launch("stop",card,"");}
        internal void OpenAdd(){
            if(Editor!=null||Settings!=null)return;editorScroll=ScrollOffset;
            ShowEditor(new Target{Name="",Url=""},new CardPreference());
        }
        void ShowEditor(Target target,CardPreference preference){
            Editor=new TargetEditorPage(target,preference,colors);
            Editor.BackRequested+=CloseEditor;Editor.SaveRequested+=SaveEditor;
            content.Visible=false;toolbar.Visible=false;Controls.Add(Editor);Editor.BringToFront();Editor.NameInput.Box.Focus();
        }
        void EditCard(TargetCard card){OpenEditor(card.Target.Name);}
        internal void OpenEditor(string name){
            TargetCard card;if(Editor!=null||Settings!=null||!Cards.TryGetValue(name,out card))return;
            Select(card);editorScroll=ScrollOffset;
            ShowEditor(card.Target,card.Preference);
        }
        internal void CloseEditor(){
            if(Editor==null)return;
            if(!Editor.Save.Enabled){Editor.ShowError("正在保存，请等待本页校验完成。");return;}
            var previous=Editor;Editor=null;Controls.Remove(previous);previous.Dispose();
            content.Visible=true;toolbar.Visible=true;Arrange();ScrollOffset=editorScroll;
            foreach(var card in Cards.Values)card.ClearPointer();
        }
        void SaveEditor(){
            Mark("editor-save begin");
            if(Editor==null)return;
            var editor=Editor;
            if(editor.IsNew){SaveConnection(editor,null);return;}
            TargetCard card;if(!Cards.TryGetValue(editor.TargetName,out card)){editor.ShowError("所选云电脑已不存在，请返回列表。");return;}
            if(IsBusy(card.Target.Name)){editor.ShowError("此云电脑正在处理操作，请完成后重试。");return;}
            bool changed=!String.Equals(editor.Url.TrimEnd('/'),card.Target.Url,StringComparison.OrdinalIgnoreCase);
            bool authChanged=editor.AutoLogin!=card.Target.AutoLogin;
            if((changed||editor.Password.Length>0||authChanged)&&card.Target.State!="stopped"){editor.ShowError("请先停止此连接，再修改地址、密码或自动登录；备注和图标可随时修改。");return;}
            if(changed&&targets.Any(t=>t.Name!=card.Target.Name&&String.Equals(t.Url,editor.Url.TrimEnd('/'),StringComparison.OrdinalIgnoreCase))){editor.ShowError("该地址已经添加，未覆盖其他云电脑。");return;}
            if(changed||editor.Password.Length>0||authChanged){SaveConnection(editor,card);return;}
            try{
                string name=card.Target.Name,url=editor.Url;
                Preferences.Set(name,editor.DisplayName,editor.IconData,targets);SavePreferences();Mark("editor-save preferences saved");card.UpdatePreference(Preferences.Get(name));Mark("editor-save card presentation updated");
                CloseEditor();Mark("editor-save returned to list");if(changed)Launch("edit",Cards[name],url);RefreshState();Mark("editor-save complete");
            }catch{if(Editor!=null)Editor.ShowError("无法保存界面偏好，未更改连接信息。");else Error("无法保存界面偏好，未更改连接信息。");}
        }
        void SaveConnection(TargetEditorPage editor,TargetCard card){
            if(preview){editor.ShowError("此预览不会访问网络或保存连接；请使用主程序添加。");return;}
            if(children.Any(p=>p.Action=="add"||p.Action=="edit")){editor.ShowError("正在校验另一项保存，请稍后重试。");return;}
            try{
                var worker=new InlineWorker(kit,editor.IsNew?"add":"edit",editor.TargetName,editor.Url,editor.Password,editor.AutoLogin);
                children.Add(new PendingAction{Worker=worker,Process=worker.Process,Name=editor.TargetName,Action=editor.IsNew?"add":"edit",Label=editor.DisplayName,Icon=editor.IconData});
                editor.PasswordInput.Box.Clear();editor.SetBusy(true);editor.ShowError("正在校验地址和登录协议…");
            }catch{editor.ShowError("无法启动校验，请确认便携包完整。");}
        }
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
                            Preferences.Set(name,pending.Label,pending.Icon,saved);
                            try{SavePreferences();pending.Saved=true;TargetCard card;if(Cards.TryGetValue(name,out card))card.UpdatePreference(Preferences.Get(name));}
                            catch{Error("地址已保存，但备注或图标保存失败，请稍后编辑。");pending.Saved=true;}
                        }
                    }else progress[pending.Name]=message;
                }
                try{if(!exited)continue;
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
        void DeleteCard(TargetCard card){Select(card);if(preview){targets.Remove(card.Target);Cards.Remove(card.Target.Name);list.Controls.Remove(card);card.Dispose();Arrange();return;}if(MessageBox.Show(this,(L.Language=="en"?"Remove this cloud PC and stop its connection?\r\n":"删除这台云电脑的本地配置并停止它的连接？\r\n")+card.Target.Url+(L.Language=="en"?"\r\nVPS and local files are preserved. Other connections remain unchanged.":"\r\n不会删除 VPS 或本机文件，其他连接保持不变。"),L.Text("删除云电脑"),MessageBoxButtons.OKCancel,MessageBoxIcon.Warning)==DialogResult.OK)Launch("remove",card,"");}
        void CopyCard(TargetCard card){try{Clipboard.SetText(card.Target.Url);notice="地址已复制（不包含登录凭据）";status.Text=L.Text(notice);}catch{Error("剪贴板暂时不可用，请稍后重试。");}}
        TargetCard CreateCard(Target target){var card=new TargetCard(target,Preferences.Get(target.Name)){Margin=new Padding(0,0,0,Palette.Gap),Font=Font};card.SelectedCard+=Select;card.ConnectRequested+=ConnectCard;card.StopRequested+=StopCard;card.EditRequested+=EditCard;card.DeleteRequested+=DeleteCard;card.CopyRequested+=CopyCard;card.OpenRequested+=delegate(TargetCard c){Select(c);Launch("open",c,"");};card.LogsRequested+=delegate{if(!preview)OpenLocal(stateDirectory);};card.MoveRequested+=MoveByKeyboard;card.SizeChanged+=delegate{Arrange();};
            card.DragEnter+=delegate(object sender,DragEventArgs e){e.Effect=CanDrop(e)?DragDropEffects.Move:DragDropEffects.None;};card.DragOver+=delegate(object sender,DragEventArgs e){e.Effect=CanDrop(e)?DragDropEffects.Move:DragDropEffects.None;};card.DragDrop+=delegate(object sender,DragEventArgs e){if(CanDrop(e))DropMove((string)e.Data.GetData(typeof(string)),card.Target.Name,card.PointToClient(new Point(e.X,e.Y)).Y>card.Height/2);};return card;}
        bool CanDrop(DragEventArgs e){return e.Data.GetDataPresent(typeof(string))&&Cards.ContainsKey((string)e.Data.GetData(typeof(string)));}
        internal void MoveCard(string from,string before){try{Preferences.Move(from,before,targets);SavePreferences();Arrange(true);}catch{Error("排序未能保存，请检查界面偏好文件。");}}
        internal void DropMove(string from,string hit,bool after){if(from==hit)return;var ordered=Preferences.Sort(targets).Where(t=>t.Name!=from).ToList();int index=ordered.FindIndex(t=>t.Name==hit);if(index<0)return;MoveCard(from,after?(index+1<ordered.Count?ordered[index+1].Name:""):hit);}
        void MoveByKeyboard(TargetCard card,int direction){var ordered=Preferences.Sort(targets);int index=ordered.FindIndex(t=>t.Name==card.Target.Name);if(index+direction<0||index+direction>=ordered.Count)return;MoveCard(card.Target.Name,direction<0?ordered[index-1].Name:index+2<ordered.Count?ordered[index+2].Name:"");}
        internal void RefreshState(){
            CollectActions();
            var snapshot=preview?new Snapshot{Running=true,Targets=!previewInitialized?Demo().Targets:targets}:LocalState.Load(stateDirectory);targets=snapshot.Targets;previewInitialized=true;
            count.Text="云电脑  ·  "+targets.Count;
            status.Text=notice.Length>0?notice:preview?"交互预览 · 示例数据，不会连接 VPS":snapshot.ReadError?"本地状态暂时无法完整读取，将自动刷新":Preferences.ReadError?"界面偏好文件无法读取，已保留原文件":snapshot.Stale?"后台状态未更新，请检查连接":snapshot.Running?targets.Count(t=>t.State=="connected")+" 台已连接 · 每台云电脑独立控制":"后台尚未运行 · 打开界面不会自动连接";
            if(L.Language=="en"){count.Text="Cloud PCs  ·  "+targets.Count;status.Text=snapshot.Running&&notice.Length==0&&!preview&&!snapshot.ReadError&&!snapshot.Stale?targets.Count(t=>t.State=="connected")+" connected · Each PC is controlled independently":L.Message(status.Text);empty.Text="No cloud PCs yet\r\nAdd a cloud PC to get started.";}else empty.Text="还没有云电脑\r\n点击右上角「添加云电脑」，保存地址后即可连接。";
            foreach(var key in Cards.Keys.Where(key=>!targets.Any(t=>t.Name==key)).ToArray()){var old=Cards[key];Cards.Remove(key);list.Controls.Remove(old);old.Dispose();}
            if(!targets.Any(t=>t.Name==selected))selected=targets.Count>0?targets[0].Name:"";
            foreach(var target in targets){TargetCard card;if(!Cards.TryGetValue(target.Name,out card)){card=CreateCard(target);Cards.Add(target.Name,card);list.Controls.Add(card);}
                card.BusyConnect=children.Any(p=>p.Name==target.Name&&p.Action=="connect"&&!p.Superseded);card.BusyStop=children.Any(p=>p.Name==target.Name&&(p.Action=="stop"||p.Action=="remove"));
                string message;if(progress.TryGetValue(target.Name,out message)){
                    bool waiting=card.BusyConnect&&message.StartsWith("[4/5]")&&(target.State=="waiting-login"||target.State=="offline"||target.State=="configuring");
                    target.Detail=waiting?LocalState.Caption(target.State)+" · "+target.Detail:message;
                }
                if(target.AutoLogin&&(target.State=="password"||target.State=="locked"||target.State=="expired"))target.Detail=LocalState.Detail(target.State);
                card.RefreshTarget(target);card.Edit.Enabled=card.Delete.Enabled=!IsBusy(target.Name);
            }
            toolbar.Add.Enabled=!children.Any(p=>p.Action=="add"||p.Action=="edit"||p.Action=="remove");Arrange();ApplyTheme();
        }
        void Arrange(){Arrange(false);}
        void Arrange(bool animate){if(arranging||IsDisposed)return;arranging=true;try{
            if(Cards.Count==0){if(!list.Controls.Contains(empty))list.Controls.Add(empty);empty.Visible=true;empty.Width=Math.Max(100,list.ClientSize.Width-22);}
            else{list.Controls.Remove(empty);list.Place(Preferences.Sort(targets).Where(t=>Cards.ContainsKey(t.Name)&&Cards[t.Name].Parent==list).Select(t=>Cards[t.Name]).ToList(),animate);}
        }finally{arranging=false;}}

        internal bool TestIndependentButtons(){if(Cards.Count!=2)return false;var cards=Cards.Values.ToArray();var process=Process.GetCurrentProcess();var pending=new PendingAction{Process=process,Name=cards[0].Target.Name,Action="connect"};try{children.Add(pending);RefreshState();return cards[0].BusyConnect&&cards[0].Details.Stop.Enabled&&!cards[0].Edit.Enabled&&!cards[1].BusyConnect&&cards[1].Edit.Enabled&&cards[1].Details.Open.Enabled;}finally{children.Remove(pending);process.Dispose();RefreshState();}}
        internal bool LayoutFits(){return (Editor==null||Editor.LayoutFits)&&Cards.Values.All(c=>c.Right<=list.ClientSize.Width&&c.Connect.Left>=40&&c.Delete.Right<c.Width&&c.Details.Open.Right<c.Details.Width&&c.Details.Logs.Right<c.Details.Width)&&toolbar.Add.Right<=toolbar.ClientSize.Width&&toolbar.Theme.Left>toolbar.UpdateButton.Right;}
        internal int ScrollOffset { get { return -list.AutoScrollPosition.Y; } set { list.AutoScrollPosition=new Point(0,value); } }
        internal static Snapshot Demo(){var s=new Snapshot{Running=true};s.Targets.Add(new Target{Name="preview-a",Url="https://desktop1.example.com",Mode="共享网页登录",State="connected",Detail=LocalState.Detail("connected")});s.Targets.Add(new Target{Name="preview-b",Url="https://desktop2.example.com",Mode="共享网页登录",State="stopped",Detail=LocalState.Detail("stopped")});return s;}
    }
}
