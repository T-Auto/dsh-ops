param([Parameter(Mandatory)][string]$Path)
$ProgressPreference = 'SilentlyContinue'
# Legacy disposition deliberately keeps the name pending deletion until this
# handle closes. Unlike POSIX unlink, a competing open must report contention.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PendingSidecar {
  [StructLayout(LayoutKind.Sequential)] public struct Disposition { public byte DeleteFile; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition value, uint size);
  public static SafeFileHandle Open(string path) {
    var handle = CreateFileW(path, 0x10000, 7, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception();
    var disposition = new Disposition { DeleteFile = 1 };
    if (!SetFileInformationByHandle(handle, 4, ref disposition, 1)) {
      var error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(error);
    }
    return handle;
  }
}
'@
$h = [PendingSidecar]::Open($Path)
