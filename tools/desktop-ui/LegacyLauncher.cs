using System;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace CMCP {
    internal static class LegacyLauncher {
        [STAThread] static int Main(string[] args) {
            try {
                string executable=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"CMCP.exe");
                var entry=Assembly.LoadFrom(executable).EntryPoint;
                return Convert.ToInt32(entry.Invoke(null,new object[]{args}));
            }catch{
                MessageBox.Show("CMCP.exe 无法启动，请使用完整安装包。","CMCP",MessageBoxButtons.OK,MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
