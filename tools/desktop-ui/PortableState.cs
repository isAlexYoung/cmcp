using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace CMCP {
    internal static class PortableState {
        internal static string InstanceKey { get {
            string scope=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            // Explicit private state directories have independent windows and signals.
            // Ordinary launches retain the existing per-account singleton.
            if(Environment.GetEnvironmentVariable("CMCP_STATE_DIR")!=null)scope+="\n"+DirectoryPath;
            using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(scope.ToLowerInvariant()))).Replace("-", "").Substring(0,20);
        } }
        internal static string Legacy { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClaudeLocalMcp"); } }
        internal static string DirectoryPath { get { return Path.GetFullPath(Environment.GetEnvironmentVariable("CMCP_STATE_DIR") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"user")); } }
        internal static string PreferencesPath { get { return Directory.Exists(DirectoryPath) ? DirectoryPath : Legacy; } }
        internal static string TransactionPath(string root,string id) { return Path.Combine(Path.GetDirectoryName(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)),".cmcp-update-"+id); }
    }
}
