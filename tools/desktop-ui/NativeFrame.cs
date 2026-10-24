using System;
using System.Drawing;
using System.Runtime.InteropServices;

namespace CMCP {
    internal static class NativeFrame {
        internal static int? LastDarkModeResult, LastCaptionResult, LastTextResult;
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        internal static void Apply(IntPtr window, Palette colors) {
            try {
                int dark = colors.Dark ? 1 : 0;
                LastDarkModeResult=DwmSetWindowAttribute(window,20,ref dark,sizeof(int));
                // Windows 11 supplies explicit caption and text colors. Older
                // systems can reject these attributes without affecting UI.
                int caption = colors.Dark ? ColorTranslator.ToWin32(colors.Page) : -1;
                int text = colors.Dark ? ColorTranslator.ToWin32(colors.Text) : -1;
                LastCaptionResult=DwmSetWindowAttribute(window,35,ref caption,sizeof(int));
                LastTextResult=DwmSetWindowAttribute(window,36,ref text,sizeof(int));
            } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
        }

    }
}
