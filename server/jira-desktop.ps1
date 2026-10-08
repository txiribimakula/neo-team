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
  [StructLayout(LayoutKind.Sequential)] public struct MinMax { public Point Reserved, MaxSize, MaxPosition, MinTrack, MaxTrack; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, ref MinMax m, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public static string Title(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h,s,s.Capacity); return s.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h,out p); return p; }
  public static IntPtr[] Windows() { var list = new List<IntPtr>(); EnumWindows((h,p) => { if(IsWindowVisible(h) && Title(h).Length > 0) list.Add(h); return true; }, IntPtr.Zero); return list.ToArray(); }
  public static int Minimum(IntPtr h) { var m = new MinMax(); IntPtr result; SendMessageTimeout(h,0x24,IntPtr.Zero,ref m,2,250,out result); return Math.Max(320,m.MinTrack.X); }
  public static bool Place(IntPtr h, int x, int y, int w, int height) {
    bool restore = IsIconic(h) || IsZoomed(h);
    if(restore) ShowWindowAsync(h,9);
    Rect r; GetWindowRect(h,out r);
    if(!restore && r.Left==x && r.Top==y && r.Right-r.Left==w && r.Bottom-r.Top==height) return false;
    if(!SetWindowPos(h,IntPtr.Zero,x,y,w,height,0x0014)) throw new Exception("Windows no permite mover la ventana (comprueba permisos/elevacion).");
    return true;
  }
}
'@
[void][NeoLayout]::SetProcessDPIAware()
$last = ''; $browser = [IntPtr]::Zero; $lastPlacement = [DateTime]::MinValue
function Log($message, $kind = 'info') { @{kind=$kind;message=$message} | ConvertTo-Json -Compress | Write-Output }
while (Test-Path -LiteralPath $ConfigFile) {
  try {
    $config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if ($config.stop -or !(Get-Process -Id $config.owner -ErrorAction SilentlyContinue)) { break }
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
    $status = ''; $kind = 'info'
    if ($browser -eq [IntPtr]::Zero) { $status = 'Esperando el navegador: abre la pestana de Neo Team en este escritorio.' }
    else {
      $area = [System.Windows.Forms.Screen]::FromHandle($browser).WorkingArea
      $width = [NeoLayout]::Minimum($browser)
      if ($width -ge $area.Width) { $status = 'El monitor no tiene ancho suficiente para mostrar las dos ventanas.'; $kind = 'warning' }
      else {
        $changed = [NeoLayout]::Place($browser,$area.Left,$area.Top,$width,$area.Height)
        $apps = @($windows | Where-Object { $config.application -gt 0 -and [NeoLayout]::Pid($_) -eq $config.application -and [NeoLayout]::Pid($_) -ne [NeoLayout]::Pid($browser) })
        if (!$apps.Count) { $status = 'Navegador a la izquierda. Esperando la ventana de la aplicacion registrada con neo_desktop.' }
        else {
          $limited = $false
          foreach ($handle in $apps) {
            $rect = New-Object NeoLayout+Rect
            [void][NeoLayout]::GetWindowRect($handle,[ref]$rect)
            $appWidth = $area.Width-$width; $appHeight = $area.Height
            # Fixed-size dialogs keep their size and are placed within the right pane.
            if (([NeoLayout]::GetWindowLong($handle,-16) -band 0x40000) -eq 0) {
              $appWidth = $rect.Right-$rect.Left; $appHeight = $rect.Bottom-$rect.Top
            } else { $appWidth = [Math]::Max($appWidth,[NeoLayout]::Minimum($handle)) }
            if ($appWidth -gt ($area.Width-$width) -or $appHeight -gt $area.Height) { $limited = $true }
            $changed = [NeoLayout]::Place($handle,($area.Left+$width),$area.Top,$appWidth,$appHeight) -or $changed
            [void][NeoLayout]::GetWindowRect($handle,[ref]$rect)
            if ($rect.Left -lt ($area.Left+$width) -or $rect.Right -gt $area.Right) { $limited = $true }
          }
          $status = "Distribucion mantenida: navegador ${width}px a la izquierda; aplicacion PID $($config.application), $($area.Width-$width)px a la derecha ($($apps.Count) ventanas)."
          if ($limited) { $status = 'La aplicacion tiene un tamano minimo mayor que el espacio disponible o Windows no acepta el ajuste completo.'; $kind = 'warning' }
          if ($changed -and ([DateTime]::UtcNow-$lastPlacement).TotalSeconds -ge 5) {
            Log "Reajuste de ventanas. $status"
            $lastPlacement = [DateTime]::UtcNow
          }
        }
      }
    }
    if ($status -ne $last) { Log $status $kind; $last = $status }
  } catch {
    $status = "No se pudo conservar la distribucion; se reintentara: $($_.Exception.Message)"
    if ($status -ne $last) { Log $status 'warning'; $last = $status }
  }
  Start-Sleep -Milliseconds 750
}
