using System;
using System.IO;

namespace CMCP {
    internal static class PortableState {
        internal static string Legacy { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClaudeLocalMcp"); } }
        internal static string DirectoryPath { get { return Path.GetFullPath(Environment.GetEnvironmentVariable("CMCP_STATE_DIR") ?? Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"user")); } }
        internal static string PreferencesPath { get { return Directory.Exists(DirectoryPath) ? DirectoryPath : Legacy; } }
        internal static string TransactionPath(string root,string id) { return Path.Combine(Path.GetDirectoryName(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)),".cmcp-update-"+id); }
    }
}
