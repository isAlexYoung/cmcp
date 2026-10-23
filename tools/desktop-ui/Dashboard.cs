using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace ClaudeMcp {
    internal sealed class Manager : Form {
        readonly string root = AppDomain.CurrentDomain.BaseDirectory;
        readonly string kit = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
        readonly string stateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeLocalMcp");
        readonly bool preview;
        readonly DashboardToolbar toolbar = new DashboardToolbar();
        readonly FlowLayoutPanel list = new FlowLayoutPanel();
        readonly Label status = new Label(), count = new Label(), empty = new Label();
        readonly Panel content = new Panel();
        internal TargetEditorPage Editor;
        internal Action<string> Trace;
        void Mark(string message){if(Trace!=null)Trace(message);}
        int editorScroll;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        sealed class PendingAction { internal Process Process; internal string Name, Action; }
        readonly List<PendingAction> children = new List<PendingAction>();
        internal readonly Dictionary<string,TargetCard> Cards = new Dictionary<string,TargetCard>(StringComparer.Ordinal);
        internal UiPreferences Preferences;
        Palette colors;
        List<Target> targets = new List<Target>();
        string selected = "", notice = "";
        bool arranging, previewInitialized;
        internal Manager(bool demo, string stateOverride = null) {
            if (stateOverride != null) stateDirectory = stateOverride;
            preview = demo; Preferences = demo ? new UiPreferences() : UiPreferences.Load(stateDirectory);
            colors=Palette.Create(Preferences.dark);Text="CMCP";
            Icon=System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font=new Font("Microsoft YaHei UI",11F);AutoScaleMode=AutoScaleMode.Dpi;
            ClientSize=new Size(1100,720);MinimumSize=new Size(660,500);StartPosition=FormStartPosition.CenterScreen;
            content.Dock=DockStyle.Fill;content.Padding=new Padding(28,10,28,0);
            var heading = new Panel { Dock=DockStyle.Top, Height=66 };
            count.Bounds=new Rectangle(0,2,400,28);count.Font=new Font(Font.FontFamily,12F,FontStyle.Bold);heading.Controls.Add(count);
            status.Bounds=new Rectangle(0,34,850,24);status.Anchor=AnchorStyles.Left|AnchorStyles.Right|AnchorStyles.Top;heading.Controls.Add(status);
            list.Dock=DockStyle.Fill;list.FlowDirection=FlowDirection.TopDown;list.WrapContents=false;list.AutoScroll=true;
            empty.AutoSize=false;empty.Size=new Size(600,150);empty.TextAlign=ContentAlignment.MiddleCenter;empty.Text="还没有云电脑\r\n点击右上角「添加云电脑」，保存地址后即可连接。";empty.Margin=new Padding(0,30,0,0);
            content.Controls.Add(list);content.Controls.Add(heading);Controls.Add(content);Controls.Add(toolbar);
            toolbar.Add.Click+=delegate{Launch("add",null,"");};toolbar.Theme.Click+=delegate{SetTheme(!Preferences.dark);};
            list.SizeChanged+=delegate{Arrange();};timer.Interval=2000;timer.Tick+=delegate{RefreshState();};timer.Start();
            Deactivate+=delegate{foreach(var card in Cards.Values)card.ClearPointer();};
            FormClosed+=delegate{timer.Stop();timer.Dispose();foreach(var p in children)p.Process.Dispose();};RefreshState();ApplyTheme();
        }
        void ApplyTheme(){
            BackColor=colors.Page;list.BackColor=colors.Page;toolbar.Apply(colors);
            status.ForeColor=colors.Muted;count.ForeColor=empty.ForeColor=colors.Text;
            foreach(var card in Cards.Values){card.Selected=card.Target.Name==selected;card.Apply(colors);}
            if(Editor!=null)Editor.Apply(colors);
            if(IsHandleCreated)NativeFrame.Apply(Handle,colors);
            Invalidate(true);
        }
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);if(colors!=null)NativeFrame.Apply(Handle,colors);}
        protected override bool ProcessCmdKey(ref Message m,Keys keys){
            if(keys==Keys.Tab||keys==(Keys.Shift|Keys.Tab))foreach(var card in Cards.Values)card.BeginKeyboardNavigation();
            return base.ProcessCmdKey(ref m,keys);
        }
        internal void SetTheme(bool dark){bool old=Preferences.dark;Preferences.dark=dark;try{SavePreferences();colors=Palette.Create(dark);ApplyTheme();}catch{Preferences.dark=old;Error("主题偏好未能保存，请检查界面偏好文件权限。");}}
        void SavePreferences(){if(!preview)Preferences.Save(stateDirectory);}
        void Error(string text){notice=text;status.Text=text;status.ForeColor=colors.Danger;}
        void OpenLocal(string path){try{if(!File.Exists(path)&&!Directory.Exists(path)){MessageBox.Show(this,"该位置尚不存在。首次连接后会生成日志。",Text);return;}Process.Start(new ProcessStartInfo(path){UseShellExecute=true});}catch{Error("无法打开该位置，请检查文件是否存在。");}}
        void Select(TargetCard card){selected=card.Target.Name;foreach(var other in Cards.Values){other.Selected=other==card;other.Apply(colors);}}
        bool IsBusy(string name){return children.Any(p=>p.Name==name);}
        void Launch(string action,TargetCard card,string initialUrl){
            if(preview){if(card!=null&&(action=="connect"||action=="stop")){card.Target.State=action=="connect"?"connected":"stopped";card.Target.Detail=LocalState.Detail(card.Target.State);card.RefreshTarget(card.Target);}return;}
            if(action!="add"&&card==null)return;
            string name=card==null?"":card.Target.Name;
            if(children.Any(p=>p.Name==name&&p.Action==action))return;
            if((action=="edit"||action=="remove")&&IsBusy(name)){Error("此卡片正在处理操作，请完成后重试。");return;}
            if((action=="connect"||action=="stop")&&children.Any(p=>p.Name==name&&(p.Action=="edit"||p.Action=="remove"))){Error("此卡片正在修改，请完成后重试。");return;}
            try{children.Add(new PendingAction{Process=Actions.Start(kit,action,name,initialUrl),Name=name,Action=action});notice="";RefreshState();}catch{Error("操作向导无法打开，请确认便携包完整且 Windows PowerShell 可用。");}
        }
        void ConnectCard(TargetCard card){Select(card);bool active=card.Target.State=="connected"||card.BusyConnect||card.Target.State=="connecting"||card.Target.State=="configuring"||card.Target.State=="waiting-login";if(active)StopCard(card);else Launch("connect",card,"");}
        void StopCard(TargetCard card){if(preview||MessageBox.Show(this,"只停止这台云电脑的连接？\r\n"+card.Target.Url+"\r\n其他云电脑不受影响。","停止连接",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)==DialogResult.OK)Launch("stop",card,"");}
        void EditCard(TargetCard card){OpenEditor(card.Target.Name);}
        internal void OpenEditor(string name){
            TargetCard card;if(Editor!=null||!Cards.TryGetValue(name,out card))return;
            Select(card);editorScroll=ScrollOffset;
            Editor=new TargetEditorPage(card.Target,card.Preference,colors);
            Editor.BackRequested+=CloseEditor;Editor.SaveRequested+=SaveEditor;
            content.Visible=false;toolbar.Visible=false;
            Controls.Add(Editor);Editor.BringToFront();Editor.NameInput.Box.Focus();
        }
        internal void CloseEditor(){
            if(Editor==null)return;
            var previous=Editor;Editor=null;Controls.Remove(previous);previous.Dispose();
            content.Visible=true;toolbar.Visible=true;Arrange();ScrollOffset=editorScroll;
            foreach(var card in Cards.Values)card.ClearPointer();
        }
        void SaveEditor(){
            Mark("editor-save begin");
            if(Editor==null)return;
            var editor=Editor;
            TargetCard card;if(!Cards.TryGetValue(editor.TargetName,out card)){editor.ShowError("所选云电脑已不存在，请返回列表。");return;}
            if(IsBusy(card.Target.Name)){editor.ShowError("此云电脑正在处理操作，请完成后重试。");return;}
            bool changed=!String.Equals(editor.Url.TrimEnd('/'),card.Target.Url,StringComparison.OrdinalIgnoreCase);
            if(changed&&card.Target.State!="stopped"){editor.ShowError("请先停止此连接，再修改云电脑地址；备注和图标可随时修改。");return;}
            if(changed&&targets.Any(t=>t.Name!=card.Target.Name&&String.Equals(t.Url,editor.Url.TrimEnd('/'),StringComparison.OrdinalIgnoreCase))){editor.ShowError("该地址已经添加，未覆盖其他云电脑。");return;}
            try{
                string name=card.Target.Name,url=editor.Url;
                Preferences.Set(name,editor.DisplayName,editor.IconData,targets);SavePreferences();Mark("editor-save preferences saved");RebuildCard(name);Mark("editor-save card rebuilt");
                CloseEditor();Mark("editor-save returned to list");if(changed)Launch("edit",Cards[name],url);RefreshState();Mark("editor-save complete");
            }catch{if(Editor!=null)Editor.ShowError("无法保存界面偏好，未更改连接信息。");else Error("无法保存界面偏好，未更改连接信息。");}
        }
        void DeleteCard(TargetCard card){Select(card);if(preview){targets.Remove(card.Target);Cards.Remove(card.Target.Name);list.Controls.Remove(card);card.Dispose();Arrange();return;}if(MessageBox.Show(this,"删除这台云电脑的本地配置并停止它的连接？\r\n"+card.Target.Url+"\r\n不会删除 VPS 或本机文件，其他连接保持不变。","删除云电脑",MessageBoxButtons.OKCancel,MessageBoxIcon.Warning)==DialogResult.OK)Launch("remove",card,"");}
        void CopyCard(TargetCard card){try{Clipboard.SetText(card.Target.Url);notice="地址已复制（不包含登录凭据）";status.Text=notice;}catch{Error("剪贴板暂时不可用，请稍后重试。");}}
        TargetCard CreateCard(Target target){var card=new TargetCard(target,Preferences.Get(target.Name)){Margin=new Padding(0,0,0,Palette.Gap),Font=Font};card.SelectedCard+=Select;card.ConnectRequested+=ConnectCard;card.StopRequested+=StopCard;card.EditRequested+=EditCard;card.DeleteRequested+=DeleteCard;card.CopyRequested+=CopyCard;card.OpenRequested+=delegate(TargetCard c){Select(c);Launch("open",c,"");};card.LogsRequested+=delegate{if(!preview)OpenLocal(stateDirectory);};card.MoveRequested+=MoveByKeyboard;
            card.DragEnter+=delegate(object sender,DragEventArgs e){e.Effect=CanDrop(e)?DragDropEffects.Move:DragDropEffects.None;};card.DragOver+=delegate(object sender,DragEventArgs e){e.Effect=CanDrop(e)?DragDropEffects.Move:DragDropEffects.None;};card.DragDrop+=delegate(object sender,DragEventArgs e){if(CanDrop(e))DropMove((string)e.Data.GetData(typeof(string)),card.Target.Name,card.PointToClient(new Point(e.X,e.Y)).Y>card.Height/2);};return card;}
        bool CanDrop(DragEventArgs e){return e.Data.GetDataPresent(typeof(string))&&Cards.ContainsKey((string)e.Data.GetData(typeof(string)));}
        internal void MoveCard(string from,string before){try{Preferences.Move(from,before,targets);SavePreferences();Arrange();}catch{Error("排序未能保存，请检查界面偏好文件。");}}
        internal void DropMove(string from,string hit,bool after){if(from==hit)return;var ordered=Preferences.Sort(targets).Where(t=>t.Name!=from).ToList();int index=ordered.FindIndex(t=>t.Name==hit);if(index<0)return;MoveCard(from,after?(index+1<ordered.Count?ordered[index+1].Name:""):hit);}
        void MoveByKeyboard(TargetCard card,int direction){var ordered=Preferences.Sort(targets);int index=ordered.FindIndex(t=>t.Name==card.Target.Name);if(index+direction<0||index+direction>=ordered.Count)return;MoveCard(card.Target.Name,direction<0?ordered[index-1].Name:index+2<ordered.Count?ordered[index+2].Name:"");}
        void RebuildCard(string name){TargetCard old;if(!Cards.TryGetValue(name,out old))return;bool expanded=old.Expanded;Mark("rebuild create");var card=CreateCard(old.Target);Cards[name]=card;Mark("rebuild remove old");list.Controls.Remove(old);Mark("rebuild dispose old");old.Dispose();Mark("rebuild add new");list.Controls.Add(card);Mark("rebuild resize");card.SetExpanded(expanded,false);Mark("rebuild theme");ApplyTheme();Mark("rebuild arrange");Arrange();Mark("rebuild complete");}
        internal void RefreshState(){
            foreach(var pending in children.ToArray()){try{if(!pending.Process.HasExited)continue;if(pending.Process.ExitCode!=0)Error("上次操作未完成，请查看向导或日志；其他连接不受影响。");}catch{}pending.Process.Dispose();children.Remove(pending);}
            var snapshot=preview?new Snapshot{Running=true,Targets=!previewInitialized?Demo().Targets:targets}:LocalState.Load(stateDirectory);targets=snapshot.Targets;previewInitialized=true;
            count.Text="云电脑  ·  "+targets.Count;
            status.Text=notice.Length>0?notice:preview?"交互预览 · 示例数据，不会连接 VPS":snapshot.ReadError?"本地状态暂时无法完整读取，将自动刷新":Preferences.ReadError?"界面偏好文件无法读取，已保留原文件":snapshot.Stale?"后台状态未更新，请检查连接":snapshot.Running?targets.Count(t=>t.State=="connected")+" 台已连接 · 每台云电脑独立控制":"后台尚未运行 · 打开界面不会自动连接";
            foreach(var key in Cards.Keys.Where(key=>!targets.Any(t=>t.Name==key)).ToArray()){var old=Cards[key];Cards.Remove(key);list.Controls.Remove(old);old.Dispose();}
            if(!targets.Any(t=>t.Name==selected))selected=targets.Count>0?targets[0].Name:"";
            foreach(var target in targets){TargetCard card;if(!Cards.TryGetValue(target.Name,out card)){card=CreateCard(target);Cards.Add(target.Name,card);list.Controls.Add(card);}
                card.BusyConnect=children.Any(p=>p.Name==target.Name&&p.Action=="connect");card.BusyStop=children.Any(p=>p.Name==target.Name&&(p.Action=="stop"||p.Action=="remove"));card.RefreshTarget(target);card.Edit.Enabled=card.Delete.Enabled=!IsBusy(target.Name);
            }
            toolbar.Add.Enabled=!children.Any(p=>p.Action=="add"||p.Action=="edit"||p.Action=="remove");Arrange();ApplyTheme();
        }
        void Arrange(){if(arranging||IsDisposed)return;arranging=true;list.SuspendLayout();try{if(Cards.Count==0){if(!list.Controls.Contains(empty))list.Controls.Add(empty);empty.Visible=true;empty.Width=Math.Max(100,list.ClientSize.Width-22);}else{list.Controls.Remove(empty);int index=0;foreach(var target in Preferences.Sort(targets)){TargetCard card;if(!Cards.TryGetValue(target.Name,out card))continue;list.Controls.SetChildIndex(card,index++);card.Width=Math.Max(420,list.ClientSize.Width-22);card.PerformLayout();}}}finally{list.ResumeLayout();arranging=false;}}
        internal bool TestIndependentButtons(){if(Cards.Count!=2)return false;var cards=Cards.Values.ToArray();var process=Process.GetCurrentProcess();var pending=new PendingAction{Process=process,Name=cards[0].Target.Name,Action="connect"};try{children.Add(pending);RefreshState();return cards[0].BusyConnect&&cards[0].Details.Stop.Enabled&&!cards[0].Edit.Enabled&&!cards[1].BusyConnect&&cards[1].Edit.Enabled&&cards[1].Details.Open.Enabled;}finally{children.Remove(pending);process.Dispose();RefreshState();}}
        internal bool LayoutFits(){return (Editor==null||Editor.LayoutFits)&&Cards.Values.All(c=>c.Right<=list.ClientSize.Width&&c.Connect.Left>=40&&c.Delete.Right<c.Width&&c.Details.Open.Right<c.Details.Width&&c.Details.Logs.Right<c.Details.Width)&&toolbar.Add.Right<=toolbar.ClientSize.Width&&toolbar.Theme.Left>toolbar.UpdateButton.Right;}
        internal int ScrollOffset { get { return -list.AutoScrollPosition.Y; } set { list.AutoScrollPosition=new Point(0,value); } }
        internal static Snapshot Demo(){var s=new Snapshot{Running=true};s.Targets.Add(new Target{Name="preview-a",Url="https://desktop1.example.com",Mode="共享网页登录",State="connected",Detail=LocalState.Detail("connected")});s.Targets.Add(new Target{Name="preview-b",Url="https://desktop2.example.com",Mode="共享网页登录",State="stopped",Detail=LocalState.Detail("stopped")});return s;}
    }
}
