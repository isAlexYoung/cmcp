using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace CMCP {
    internal sealed class CloudCliLogin {
        public string name="",url="",secret="";
        public bool autoLogin;
        internal string ConnectionName {get{return "cloudcli:"+name;}}
        internal static string Protect(string text){return Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(text),null,DataProtectionScope.CurrentUser));}
        internal static bool ValidUrl(string text){Uri url;return Uri.TryCreate(text,UriKind.Absolute,out url)&&url.Scheme=="https"&&url.IsDefaultPort&&url.UserInfo.Length==0&&url.AbsolutePath=="/"&&url.Query.Length==0&&url.Fragment.Length==0;}
    }
    internal sealed class CloudCliStore {
        public int schema=1;
        public List<CloudCliLogin> logins=new List<CloudCliLogin>();
        internal bool ReadError;
        internal static string PathFor(string directory){return Path.Combine(directory,"cloudcli-logins.json");}
        internal CloudCliLogin Get(string name){return logins.FirstOrDefault(l=>l.name==name);}
        internal void Put(CloudCliLogin login){logins.RemoveAll(l=>l.name==login.name);logins.Add(login);}
        internal bool Remove(string name){return logins.RemoveAll(l=>l.name==name)>0;}
        internal static CloudCliStore Load(string directory){
            try{
                string file=PathFor(directory);if(!File.Exists(file))return new CloudCliStore();
                if(new FileInfo(file).Length>1024*1024)throw new IOException();
                var result=new JavaScriptSerializer{MaxJsonLength=1024*1024}.Deserialize<CloudCliStore>(File.ReadAllText(file,Encoding.UTF8));
                if(result==null||result.schema!=1||result.logins==null||result.logins.Count>100)throw new IOException();
                var seen=new HashSet<string>();foreach(var l in result.logins)if(l==null||String.IsNullOrEmpty(l.name)||l.name.Length>480||l.name.Any(Char.IsControl)||!seen.Add(l.name)||!CloudCliLogin.ValidUrl(l.url)||l.secret==null||l.secret.Length>16384||l.autoLogin&&l.secret.Length==0)throw new IOException();
                return result;
            }catch{return new CloudCliStore{ReadError=true};}
        }
        internal void Save(string directory){
            if(ReadError)throw new IOException("CloudCLI 配置损坏，原文件已保留。");
            Directory.CreateDirectory(directory);string file=PathFor(directory),temp=file+"."+Guid.NewGuid().ToString("N")+".tmp",key;
            using(var hash=SHA256.Create())key=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToLowerInvariant()))).Replace("-","").Substring(0,20);
            using(var mutex=new Mutex(false,"Local\\CmcpCloudCli-"+key)){
                bool held=false;try{
                    try{held=mutex.WaitOne(2000);}catch(AbandonedMutexException){held=true;}if(!held)throw new IOException("CloudCLI 配置正在保存，请稍后重试。");
                    if(File.Exists(file)&&Load(directory).ReadError)throw new IOException("CloudCLI 配置损坏，原文件已保留。");
                    File.WriteAllText(temp,new JavaScriptSerializer{MaxJsonLength=1024*1024}.Serialize(this),new UTF8Encoding(false));
                    if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);
                }finally{if(File.Exists(temp))File.Delete(temp);if(held)mutex.ReleaseMutex();}
            }
        }
    }
    internal static class CloudCliTests {
        static void Wait(){var until=DateTime.UtcNow.AddMilliseconds(320);while(DateTime.UtcNow<until){System.Windows.Forms.Application.DoEvents();Thread.Sleep(10);}}
        internal static void Run(string root,Action<bool,string> check){
            string directory=Path.Combine(root,"cloudcli-test"),password="CLOUDCLI-PRIVATE-FIXTURE";Directory.CreateDirectory(directory);
            var store=new CloudCliStore();store.Put(new CloudCliLogin{name="device",url="https://cloudcli.example.com",autoLogin=true,secret=CloudCliLogin.Protect(password)});store.Save(directory);
            string text=File.ReadAllText(CloudCliStore.PathFor(directory));var restored=CloudCliStore.Load(directory);
            check(!restored.ReadError&&restored.Get("device").autoLogin&&!text.Contains(password),"CloudCLI stores only encrypted credentials and restores its automatic sign-in setting");
            var bytes=ProtectedData.Unprotect(Convert.FromBase64String(restored.Get("device").secret),null,DataProtectionScope.CurrentUser);check(Encoding.UTF8.GetString(bytes)==password,"CloudCLI credentials use the current Windows account and match the password helper format");Array.Clear(bytes,0,bytes.Length);
            var snapshot=LocalState.Load(directory);check(snapshot.Targets.Count==1&&snapshot.Targets[0].Name=="cloudcli:device"&&snapshot.Targets[0].Mode=="CloudCLI 登录","CloudCLI publishes its own backend connection without changing desktop targets");
            using(var form=new Manager(true)){
                form.Show();Wait();form.OpenAdd();Wait();var editor=form.Editor;
                editor.NameInput.Box.Text="CLI work";editor.CloudUrlInput.Box.Text="https://cloudcli.example.com";editor.CloudRemember.Checked=true;editor.CloudPasswordInput.Box.Text=password;
                check(editor.ValidateFields(),"the device editor accepts a CloudCLI-only device with automatic sign-in");
                editor.Save.PerformClick();Wait();var card=form.Cards.Values.FirstOrDefault(c=>c.Caption=="CLI work");
                check(form.Editor==null&&card!=null&&card.CloudActive&&card.Cloud!=null&&form.Cards.Count==3,"adding CloudCLI alone creates one card and selects its own sign-in mode");
                if(card!=null){check(card.Address=="https://cloudcli.example.com"&&card.Details.Open.Text=="打开 CloudCLI","CloudCLI cards copy and display their own address and open action");form.SwitchLogin(card);Wait();check(card.SshActive,"CloudCLI can select SSH even before SSH details are saved");form.SwitchLogin(card);Wait();check(!card.SshActive&&!card.CloudActive,"the third switch returns to the desktop profile without removing CloudCLI");}
                form.Close();
            }
            File.WriteAllText(CloudCliStore.PathFor(directory),"{broken");var broken=CloudCliStore.Load(directory);bool refused=false;try{broken.Save(directory);}catch(IOException){refused=true;}check(broken.ReadError&&refused&&File.ReadAllText(CloudCliStore.PathFor(directory))=="{broken","damaged CloudCLI settings are preserved rather than replaced");
        }
    }
}
