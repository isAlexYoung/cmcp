using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ClaudeMcp {
    // Presentation only. The connector's names, credentials and switches never
    // enter this file. Corrupt/unknown data is refused, never silently replaced.
    internal sealed class CardPreference {
        public string name = "", label = "", icon = "";
    }
    internal sealed class UiPreferences {
        public int schema = 1;
        public bool dark;
        public List<CardPreference> cards = new List<CardPreference>();
        internal bool ReadError;
        internal const int MaxBytes = 4 * 1024 * 1024;
        internal static string PathFor(string directory) { return Path.Combine(directory, "dashboard-preferences.json"); }
        internal static UiPreferences Load(string directory) {
            string file = PathFor(directory);
            try {
                if (!File.Exists(file)) return new UiPreferences();
                if (new FileInfo(file).Length > MaxBytes) throw new InvalidDataException();
                var data = new JavaScriptSerializer { MaxJsonLength = MaxBytes, RecursionLimit = 8 }.Deserialize<UiPreferences>(File.ReadAllText(file, Encoding.UTF8));
                if (data == null || data.schema != 1 || data.cards == null || data.cards.Count > 100) throw new InvalidDataException();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var c in data.cards) {
                    if (c == null || String.IsNullOrEmpty(c.name) || c.name.Length > 512 || !seen.Add(c.name) || c.label == null || c.label.Length > 80 || c.label.Any(Char.IsControl) || c.icon == null || c.icon.Length > 32768) throw new InvalidDataException();
                    if (c.icon.Length > 0) using (var bmp = DecodeIcon(c.icon)) { }
                }
                return data;
            } catch { return new UiPreferences { ReadError = true }; }
        }
        internal CardPreference Get(string name) { return cards.FirstOrDefault(c => c.name == name) ?? new CardPreference { name = name }; }
        internal List<Target> Sort(IEnumerable<Target> targets) {
            var source = targets.ToList();
            return cards.Select(c => source.FirstOrDefault(t => t.Name == c.name)).Where(t => t != null).Concat(source.Where(t => !cards.Any(c => c.name == t.Name))).ToList();
        }
        internal void Save(string directory) {
            if (ReadError) throw new IOException("界面偏好文件损坏，未覆盖原文件。请先备份并检查日志目录中的 dashboard-preferences.json。");
            if (cards.Count > 100) throw new IOException("最多保存 100 张卡片。");
            string json = new JavaScriptSerializer { MaxJsonLength = MaxBytes }.Serialize(this);
            if (Encoding.UTF8.GetByteCount(json) > MaxBytes) throw new IOException("界面偏好文件过大。");
            Directory.CreateDirectory(directory);
            string key; using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToLowerInvariant()))).Replace("-", "").Substring(0,20);
            using (var mutex = new Mutex(false, "Local\\CmcpDashboard-" + key)) {
                bool held = false; string file = PathFor(directory), temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try {
                    try { held = mutex.WaitOne(2000); } catch (AbandonedMutexException) { held = true; }
                    if (!held) throw new IOException("界面设置正在被更新，请稍后再试。");
                    if (File.Exists(file) && Load(directory).ReadError) throw new IOException("原界面偏好无法读取，未覆盖。");
                    File.WriteAllText(temporary, json, new UTF8Encoding(false));
                    if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
                } finally { if (File.Exists(temporary)) File.Delete(temporary); if (held) mutex.ReleaseMutex(); }
            }
        }
        internal void Set(string name, string label, string icon, IEnumerable<Target> current) {
            var valid = new HashSet<string>(current.Select(t => t.Name), StringComparer.Ordinal);
            cards.RemoveAll(c => !valid.Contains(c.name));
            var item = cards.FirstOrDefault(c => c.name == name);
            if (item == null) { item = new CardPreference { name = name }; cards.Add(item); }
            item.label = label; item.icon = icon;
        }
        internal void Move(string from, string before, IEnumerable<Target> current) {
            var ordered = Sort(current).Select(t => Get(t.Name)).ToList();
            var item = ordered.FirstOrDefault(c => c.name == from);
            if (item == null || from == before) return;
            ordered.Remove(item);
            int index = ordered.FindIndex(c => c.name == before);
            ordered.Insert(index < 0 ? ordered.Count : index, item); cards = ordered;
        }
        internal static Bitmap DecodeIcon(string encoded) {
            var bytes = Convert.FromBase64String(encoded);
            using (var stream = new MemoryStream(bytes)) using (var image = Image.FromStream(stream, true, true)) {
                if (image.Width != 72 || image.Height != 72 || image.RawFormat.Guid != ImageFormat.Png.Guid) throw new InvalidDataException("图标格式无效。");
                return new Bitmap(image);
            }
        }
        internal static string ImportIcon(string file) {
            if (new FileInfo(file).Length > 1024 * 1024) throw new IOException("图标文件不能超过 1 MiB。");
            using (var image = Image.FromFile(file)) {
                if (image.Width > 2048 || image.Height > 2048) throw new IOException("图标尺寸不能超过 2048 × 2048。");
                using (var bitmap = new Bitmap(72,72)) using (var g = Graphics.FromImage(bitmap)) using (var stream = new MemoryStream()) {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    float ratio = Math.Min(64f / image.Width,64f / image.Height); int w = (int)(image.Width * ratio), h = (int)(image.Height * ratio);
                    g.DrawImage(image,(72-w)/2,(72-h)/2,w,h); bitmap.Save(stream, ImageFormat.Png);
                    string result = Convert.ToBase64String(stream.ToArray());
                    if (result.Length > 32768) throw new IOException("图标内容过大，请选择较简单的图片。");
                    return result;
                }
            }
        }
    }
}
