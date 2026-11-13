using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CMCP {
    // One preset of the tool market (app/mcp-market.mjs marketView).
    internal sealed class MarketItem {
        internal string Id,TitleZh,TitleEn,SummaryZh,SummaryEn,Version,License,Homepage,DescribeZh,DescribeEn,Installed,Update,BlockedZh,BlockedEn;
        internal bool Modified;
        internal readonly List<string[]> Requires=new List<string[]>(); // name, ok ("1"/"0"), hint zh, hint en
        internal string Title{get{return L.Language=="en"?TitleEn:TitleZh;}}
        internal string Summary{get{return L.Language=="en"?SummaryEn:SummaryZh;}}
        internal string Describe{get{return L.Language=="en"?DescribeEn:DescribeZh;}}
        internal string Blocked{get{return L.Language=="en"?BlockedEn:BlockedZh;}}
        static string S(IDictionary<string,object> d,string key){object v;return d!=null&&d.TryGetValue(key,out v)&&v!=null?Convert.ToString(v):null;}
        static IDictionary<string,object> O(IDictionary<string,object> d,string key){object v;return d!=null&&d.TryGetValue(key,out v)?v as IDictionary<string,object>:null;}
        internal static List<MarketItem> Parse(string json){
            var data=new JavaScriptSerializer{MaxJsonLength=8*1024*1024}.DeserializeObject(json) as IDictionary<string,object>;object raw;var list=new List<MarketItem>();
            if(data==null||!data.TryGetValue("presets",out raw))throw new FormatException("Invalid market list");
            foreach(var entry in (raw as object[])??new object[0]){
                var p=entry as IDictionary<string,object>;if(p==null)continue;
                var title=O(p,"title");var summary=O(p,"summary");var describe=O(p,"describe");var installed=O(p,"installed");var blocked=O(p,"blocked");
                var item=new MarketItem{Id=S(p,"id"),TitleZh=S(title,"zh"),TitleEn=S(title,"en"),SummaryZh=S(summary,"zh"),SummaryEn=S(summary,"en"),Version=S(p,"version"),License=S(p,"license"),Homepage=S(p,"homepage"),
                    DescribeZh=S(describe,"zh"),DescribeEn=S(describe,"en"),Installed=S(installed,"version"),Modified=installed!=null&&installed.ContainsKey("modified")&&installed["modified"] is bool&&(bool)installed["modified"],
                    Update=S(p,"update"),BlockedZh=S(blocked,"zh"),BlockedEn=S(blocked,"en")};
                object requires;if(p.TryGetValue("requires",out requires))foreach(var r in (requires as object[])??new object[0]){
                    var need=r as IDictionary<string,object>;if(need==null)continue;var hint=O(need,"hint");
                    item.Requires.Add(new[]{S(need,"name"),need.ContainsKey("ok")&&need["ok"] is bool&&(bool)need["ok"]?"1":"0",S(hint,"zh"),S(hint,"en")});
                }
                list.Add(item);
            }
            return list;
        }
        internal static readonly Dictionary<string,string> Names=new Dictionary<string,string>{{"node","Node.js"},{"uv","uv"},{"python","Python"},{"docker","Docker"},{"blender","Blender"},{"chrome","Google Chrome"}};
        internal string Requirements(){
            if(Requires.Count==0)return "";
            var parts=Requires.Select(r=>{string name;if(!Names.TryGetValue(r[0]??"",out name))name=r[0];return name+(r[1]=="1"?" ✓":" ✗");});
            string text=L.Text("需要：")+String.Join("、",parts);
            var missing=Requires.FirstOrDefault(r=>r[1]!="1");
            if(missing!=null&&(L.Language=="en"?missing[3]:missing[2])!=null)text+="  ·  "+(L.Language=="en"?missing[3]:missing[2]);
            return text;
        }
    }
    internal interface IMarketBackend {
        List<MarketItem> Market();
        void Install(string id);
        void Update(string id);
    }
    sealed partial class CliToolBackend : IMarketBackend {
        public List<MarketItem> Market(){return MarketItem.Parse(Run(null,"market"));}
        public void Install(string id){Run(null,"install","--preset",id);}
        public void Update(string id){Run(null,"update","--preset",id,"--confirmed");}
    }

    internal sealed partial class SettingsPage {
        internal IMarketBackend Market;
        List<MarketItem> marketItems;string marketError;bool marketLoading;
        internal List<MarketItem> MarketState{get{return marketItems;}}
        internal bool MarketLoading{get{return marketLoading;}}
        internal void LoadMarket(){
            if(Market==null||marketLoading)return;marketLoading=true;var backend=Market;
            ThreadPool.QueueUserWorkItem(delegate{
                List<MarketItem> items=null;string error=null;try{items=backend.Market();}catch(Exception e){error=e.Message;}
                try{BeginInvoke((Action)delegate{marketLoading=false;marketItems=items;marketError=error;if(page==MarketIndex){int y=-Viewport.AutoScrollPosition.Y;Build();Viewport.AutoScrollPosition=new Point(0,y);}});}catch{marketLoading=false;}
            });
        }
        void MarketAction(Action work,string done){
            ThreadPool.QueueUserWorkItem(delegate{
                string error=null;try{work();}catch(Exception e){error=e.Message;}
                try{BeginInvoke((Action)delegate{if(error==null)SetFeedback(done,false);else SetFeedback(L.Text("操作未完成：")+error,true);toolSnapshot=null;LoadMarket();});}catch{}
            });
        }
        void BuildMarket(){
            var intro=AddSection("工具市场");
            if(Market==null){AddRow(intro,"预览模式","预览模式下不读取工具市场。",null);return;}
            if(marketItems==null&&marketError==null){AddRow(intro,"正在读取工具市场…",null,null);LoadMarket();return;}
            if(marketError!=null){AddRow(intro,()=>L.Text("无法读取工具市场"),()=>marketError,Command("重试",delegate{marketError=null;Build();}));return;}
            AddRow(intro,"经过审核的预设","每个预设固定一个版本，只包含配置和项目链接；第一次启动时由 npx 或 uvx 从官方源下载。安装后默认关闭，到“工具”页开启。CMCP 不会自动更新它们。",null);
            var list=AddSection("预设");
            foreach(var preset in marketItems){
                string id=preset.Id;
                var actions=new MarketRowActions();
                actions.Home=Command("主页",delegate{var item=Current(id);if(item!=null&&item.Homepage!=null&&item.Homepage.StartsWith("https://"))OpenPath(item.Homepage);});
                string label=preset.Update!=null?String.Format(L.Text("更新到 {0}"),preset.Update):preset.Installed!=null?L.Text("已安装"):L.Text("安装");
                actions.Main=Command(label,delegate{
                    var item=Current(id);if(item==null)return;
                    if(item.Update!=null){
                        string text=String.Format(L.Text("把 {0} 从 {1} 更新到 {2}？"),item.Title,item.Installed,item.Update)+"\r\n\r\n"+item.Describe+(item.Modified?"\r\n\r\n"+L.Text("你改过这个工具的清单，更新会覆盖这些修改。"):"");
                        if(!ConfirmTool(text))return;
                        MarketAction(()=>Market.Update(id),"已更新，正在通知已连接的 Claude。");
                    }else if(item.Installed==null)MarketAction(()=>Market.Install(id),"已安装。到“工具”页开启后 Claude 才能使用。");
                    else ShowTools();
                },preset.Update!=null);
                actions.Main.Enabled=preset.Blocked==null||preset.Installed!=null;
                actions.Arrange();
                AddRow(list,()=>{var item=Current(id);return item==null?"":item.Title+" "+(item.Installed??item.Version);},()=>{var item=Current(id);return item==null?"":MarketDetail(item);},actions);
            }
        }
        MarketItem Current(string id){return marketItems==null?null:marketItems.FirstOrDefault(m=>m.Id==id);}
        static string MarketDetail(MarketItem m){
            var parts=new List<string>{m.Summary};
            if(m.Blocked!=null&&m.Installed==null)parts.Add(m.Blocked);
            string needs=m.Requirements();if(needs.Length>0)parts.Add(needs);
            if(m.Update!=null)parts.Add(String.Format(L.Text("有新版本 {0}"),m.Update));
            if(m.Modified)parts.Add(L.Text("清单已被手动修改"));
            if(m.License!=null)parts.Add(m.License);
            return String.Join("  ·  ",parts.Where(p=>!String.IsNullOrEmpty(p)));
        }
    }
    internal sealed class MarketRowActions : Panel {
        internal ModernButton Home,Main;
        internal void Arrange(){
            Controls.AddRange(new Control[]{Home,Main});
            foreach(var b in new[]{Home,Main})b.Size=new Size(Math.Max(64,TextRenderer.MeasureText(L.Text(b.Text),b.Font).Width+28),34);
            Home.Location=new Point(0,2);Main.Location=new Point(Home.Right+8,2);Size=new Size(Main.Right,38);
        }
    }

    internal sealed class FakeMarketBackend : IMarketBackend {
        internal readonly List<MarketItem> Items=new List<MarketItem>();internal readonly List<string> Calls=new List<string>();
        internal FakeMarketBackend(){
            var blender=new MarketItem{Id="blender_mcp",TitleZh="Blender（MCP for Blender）",TitleEn="Blender (MCP for Blender)",SummaryZh="控制本机 Blender",SummaryEn="Controls the local Blender",Version="2.2.5",License="MIT",Homepage="https://github.com/ahujasid/blender-mcp",DescribeZh="会运行 uvx mcp-for-blender==2.2.5",DescribeEn="runs uvx"};
            blender.Requires.Add(new[]{"uv","1",null,null});blender.Requires.Add(new[]{"blender","0","需要先安装 Blender","Install Blender first"});
            Items.Add(blender);
            Items.Add(new MarketItem{Id="memory",TitleZh="长期记忆",TitleEn="Long-term memory",SummaryZh="知识图谱",SummaryEn="Knowledge graph",Version="2.0.1",License="MIT",Homepage="https://github.com/modelcontextprotocol/servers",DescribeZh="会运行 npx",DescribeEn="runs npx",Installed="2.0.0",Update="2.0.1",Modified=true});
            Items.Add(new MarketItem{Id="later",TitleZh="以后",TitleEn="Later",SummaryZh="需要新版",SummaryEn="Needs newer",Version="1.0.0",BlockedZh="需要 CMCP 99.0.0 或更新版本",BlockedEn="Needs CMCP 99.0.0 or later"});
        }
        public List<MarketItem> Market(){lock(Items){Calls.Add("market");return Items.Select(i=>{var c=(MarketItem)i.GetType().GetMethod("MemberwiseClone",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(i,null);return c;}).ToList();}}
        public void Install(string id){lock(Items){Calls.Add("install "+id);var i=Items.First(x=>x.Id==id);i.Installed=i.Version;}}
        public void Update(string id){lock(Items){Calls.Add("update "+id);var i=Items.First(x=>x.Id==id);i.Installed=i.Update;i.Update=null;i.Modified=false;}}
    }
    internal static class MarketPageTests {
        static void Pump(Func<bool> done){var clock=Stopwatch.StartNew();while(!done()&&clock.ElapsedMilliseconds<5000){Application.DoEvents();Thread.Sleep(5);}}
        internal static void Run(string directory,Action<bool,string> check){
            var parsed=MarketItem.Parse("{\"presets\":[{\"id\":\"fetch\",\"title\":{\"zh\":\"抓取\",\"en\":\"Fetch\"},\"summary\":{\"zh\":\"s\",\"en\":\"s\"},\"version\":\"2026.10.28\",\"license\":\"MIT\",\"homepage\":\"https://example.com\",\"describe\":{\"zh\":\"z\",\"en\":\"e\"},\"requires\":[{\"kind\":\"runtime\",\"name\":\"uv\",\"ok\":false,\"hint\":{\"zh\":\"需要 uv\",\"en\":\"Needs uv\"}}],\"installed\":{\"version\":\"2026.10.1\",\"modified\":true,\"enabled\":true},\"update\":\"2026.10.28\",\"blocked\":null}]}");
            check(parsed.Count==1&&parsed[0].Installed=="2026.10.1"&&parsed[0].Update=="2026.10.28"&&parsed[0].Modified&&parsed[0].Requires[0][1]=="0"&&parsed[0].Requirements().Contains("uv ✗")&&parsed[0].Requirements().Contains("需要 uv"),"the market list parses presets, requirements, installed and newer versions");
            using(var form=new Manager(true)){
                form.ClientSize=new Size(760,520);form.Show();Application.DoEvents();form.OpenSettings();Application.DoEvents();
                var fake=new FakeMarketBackend();var page=form.Settings;page.Market=fake;var asked=new List<string>();bool answer=false;page.ConfirmTool=text=>{asked.Add(text);return answer;};
                page.ShowMarket();Pump(()=>page.MarketState!=null&&!page.MarketLoading);Application.DoEvents();
                var sheet=page.Viewport.Controls[0];
                Func<string,ModernButton> main=title=>sheet.Controls.OfType<MarketRowActions>().Select(a=>a.Main).FirstOrDefault(b=>b.Text==title);
                check(sheet.Controls.OfType<Label>().Any(l=>l.Text.StartsWith("Blender（MCP for Blender）"))&&sheet.Controls.OfType<Label>().Any(l=>l.Text.Contains("Blender ✗")&&l.Text.Contains("需要先安装 Blender")),"presets show their requirements and what is missing");
                var blocked=sheet.Controls.OfType<MarketRowActions>().Select(a=>a.Main).Where(b=>b.Text=="安装"&&!b.Enabled).ToList();
                check(blocked.Count==1&&sheet.Controls.OfType<Label>().Any(l=>l.Text.Contains("99.0.0")),"a preset this CMCP cannot run cannot be installed and says why");
                main("安装").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("install blender_mcp"));Pump(()=>!page.MarketLoading&&page.MarketState.First(m=>m.Id=="blender_mcp").Installed!=null);Application.DoEvents();sheet=page.Viewport.Controls[0];
                check(fake.Calls.Contains("install blender_mcp")&&main("已安装")!=null,"installing needs one click and leaves the tool off for the Tools page");
                var update=main("更新到 2.0.1");update.AccessibilityObject.DoDefaultAction();Application.DoEvents();
                check(asked.Count==1&&asked[0].Contains("2.0.0")&&asked[0].Contains("2.0.1")&&asked[0].Contains("会运行 npx")&&asked[0].Contains("覆盖")&&!fake.Calls.Contains("update memory"),"an update shows both versions, what it runs and lost local edits, and waits for the user");
                answer=true;main("更新到 2.0.1").AccessibilityObject.DoDefaultAction();Pump(()=>fake.Calls.Contains("update memory"));Pump(()=>!page.MarketLoading&&page.MarketState.First(m=>m.Id=="memory").Update==null);Application.DoEvents();sheet=page.Viewport.Controls[0];
                check(fake.Calls.Contains("update memory")&&main("更新到 2.0.1")==null,"a confirmed update is applied once and the button goes away");
                check(fake.Calls.Count(c=>c.StartsWith("update"))==1&&fake.Calls.Count(c=>c.StartsWith("install"))==1,"nothing is installed or updated without a click");
                foreach(bool dark in new[]{true,false}){form.SetTheme(dark);Application.DoEvents();}
                check(!page.Viewport.NativeBarsVisible&&page.Viewport.Controls[0].Controls.OfType<MarketRowActions>().All(a=>a.Right<=page.Viewport.Controls[0].Width),"market rows fit the page in both themes");
                L.Set("en");page.ShowMarket();Application.DoEvents();check(page.Viewport.Controls[0].Controls.OfType<Label>().Any(l=>l.Text=="Tool market"),"the market page is translated");L.Set("zh-CN");
            }
            using(var preview=new Manager(true)){
                preview.Show();Application.DoEvents();preview.OpenSettings();Application.DoEvents();preview.Settings.ShowMarket();Application.DoEvents();
                check(preview.Settings.Viewport.Controls[0].Controls.OfType<Label>().Any(l=>l.Text=="预览模式"),"the preview window never reads the market");
            }
        }
    }
}
