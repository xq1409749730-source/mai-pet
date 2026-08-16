# 前台窗口 + 空闲时长检测（识别当前任务 / 判断电脑空闲）
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowText($h, $sb, 512)
$pid2 = [uint32]0
[void][FgWin]::GetWindowThreadProcessId($h, [ref]$pid2)
$proc = Get-Process -Id ([int]$pid2) -ErrorAction SilentlyContinue

$lii = New-Object FgWin+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
$idleSeconds = 0
if ([FgWin]::GetLastInputInfo([ref]$lii)) {
  $idleSeconds = [Math]::Max(0, ([Environment]::TickCount - [int]$lii.dwTime) / 1000)
}

$o = [ordered]@{
  title = $sb.ToString()
  process = if ($proc) { $proc.ProcessName } else { '' }
  path = if ($proc) { $proc.Path } else { '' }
  idleSeconds = [int]$idleSeconds
}
$o | ConvertTo-Json -Compress
