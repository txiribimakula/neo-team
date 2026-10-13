param([Parameter(Mandatory=$true)][string]$ConfigFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class NeoLayout {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length, Flags, ShowCmd; public Point MinPosition, MaxPosition; public Rect Normal; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref Placement p);
  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref Placement p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public static string Title(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h,s,s.Capacity); return s.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h,out p); return p; }
  public static IntPtr[] Windows() { var list = new List<IntPtr>(); EnumWindows((h,p) => { if(IsWindowVisible(h) && Title(h).Length > 0) list.Add(h); return true; }, IntPtr.Zero); return list.ToArray(); }
  static Placement Get(IntPtr h) {
    var p = new Placement(); p.Length = Marshal.SizeOf(typeof(Placement));
    if(!GetWindowPlacement(h,ref p)) throw new Exception("Windows no da la posicion de la ventana.");
    p.Flags = 0; return p;
  }
  static void Set(IntPtr h, Placement p, int show) { p.ShowCmd = show; if(!SetWindowPlacement(h,ref p)) throw new Exception("Windows no permite mover la ventana (comprueba permisos/elevacion)."); }
  // Restored inside the monitor's working area and then maximized, so Windows maximizes
  // it there (the restored position is in workspace coordinates; the margin absorbs that).
  public static void Maximize(IntPtr h, int x, int y, int w, int height) {
    var p = Get(h);
    p.Normal.Left = x + w/8; p.Normal.Top = y + height/8; p.Normal.Right = x + w*7/8; p.Normal.Bottom = y + height*7/8;
    Set(h,p,4); Set(h,p,3);
  }
  // Fixed-size dialogs keep their size, centered on the monitor.
  public static void Center(IntPtr h, int x, int y, int w, int height) {
    var p = Get(h);
    int width = p.Normal.Right-p.Normal.Left, tall = p.Normal.Bottom-p.Normal.Top;
    p.Normal.Left = x+Math.Max(0,(w-width)/2); p.Normal.Top = y+Math.Max(0,(height-tall)/2); p.Normal.Right = p.Normal.Left+width; p.Normal.Bottom = p.Normal.Top+tall;
    Set(h,p,4);
  }
}
'@
[void][NeoLayout]::SetProcessDPIAware()
$last = ''; $browser = [IntPtr]::Zero; $lastPlacement = [DateTime]::MinValue
function Log($message, $kind = 'info') { @{kind=$kind;message=$message} | ConvertTo-Json -Compress | Write-Output }
function Label($screen) { if ($screen.DeviceName -match 'DISPLAY(\d+)$') { "monitor $($Matches[1])" } else { $screen.DeviceName } }
# Keeps one window maximized (or a fixed dialog centered) on its monitor; true when it had to act.
function Keep($handle, $screen) {
  $area = $screen.WorkingArea
  $here = [System.Windows.Forms.Screen]::FromHandle($handle).DeviceName -eq $screen.DeviceName
  $resizable = ([NeoLayout]::GetWindowLong($handle,-16) -band 0x40000) -ne 0
  if ($resizable) {
    if ($here -and [NeoLayout]::IsZoomed($handle)) { return $false }
    [NeoLayout]::Maximize($handle,$area.Left,$area.Top,$area.Width,$area.Height)
  } else {
    if ($here -and ![NeoLayout]::IsIconic($handle)) { return $false }
    [NeoLayout]::Center($handle,$area.Left,$area.Top,$area.Width,$area.Height)
  }
  return $true
}
while (Test-Path -LiteralPath $ConfigFile) {
  try {
    $config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if ($config.stop -or !(Get-Process -Id $config.owner -ErrorAction SilentlyContinue)) { break }
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    # The chosen monitors; without a choice (or if it is gone) the web goes to the main
    # one and the application to another, if there is one.
    $web = $screens | Where-Object { $_.DeviceName -eq $config.web } | Select-Object -First 1
    if (!$web) { $web = $screens | Where-Object { $_.Primary } | Select-Object -First 1 }
    $app = $screens | Where-Object { $_.DeviceName -eq $config.app } | Select-Object -First 1
    if (!$app) { $app = $screens | Where-Object { $_.DeviceName -ne $web.DeviceName } | Select-Object -First 1 }
    if (!$app) { $app = $web }
    $windows = @([NeoLayout]::Windows())
    # Retain the handle across browser tab switches, but never select an unrelated window.
    if ($browser -eq [IntPtr]::Zero -or $windows -notcontains $browser) {
      $browser = [IntPtr]::Zero
      foreach ($handle in $windows) {
        if ([NeoLayout]::Title($handle).Contains($config.title)) {
          $name = (Get-Process -Id ([NeoLayout]::Pid($handle)) -ErrorAction SilentlyContinue).ProcessName
          if ($name -match '^(msedge|chrome|firefox|brave|vivaldi|opera)$') { $browser = $handle; break }
        }
      }
    }
    $changed = $false; $parts = @()
    if ($browser -eq [IntPtr]::Zero) { $parts += 'Esperando el navegador: abre la pestana de Neo Team en este escritorio.' }
    else {
      $changed = Keep $browser $web
      $parts += "Web maximizada en el $(Label $web)."
    }
    $apps = @($windows | Where-Object { $config.application -gt 0 -and [NeoLayout]::Pid($_) -eq $config.application -and $_ -ne $browser })
    if (!$apps.Count) { $parts += 'Esperando la ventana de la aplicacion registrada con neo_desktop.' }
    else {
      foreach ($handle in $apps) { $changed = (Keep $handle $app) -or $changed }
      $parts += "Aplicacion PID $($config.application) maximizada en el $(Label $app) ($($apps.Count) ventanas)."
    }
    $kind = 'info'
    if ($app.DeviceName -eq $web.DeviceName) { $parts += 'Web y aplicacion comparten monitor.'; if ($screens.Count -gt 1) { $kind = 'warning' } }
    $status = $parts -join ' '
    if ($changed -and ([DateTime]::UtcNow-$lastPlacement).TotalSeconds -ge 5) {
      Log "Reajuste de ventanas. $status"
      $lastPlacement = [DateTime]::UtcNow; $last = $status
    }
    if ($status -ne $last) { Log $status $kind; $last = $status }
  } catch {
    $status = "No se pudo conservar la distribucion; se reintentara: $($_.Exception.Message)"
    if ($status -ne $last) { Log $status 'warning'; $last = $status }
  }
  Start-Sleep -Milliseconds 750
}
