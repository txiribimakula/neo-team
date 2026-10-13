import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { writeAtomic } from './jira.js';

export const desktopStage = stage => ['reproduce', 'verify'].includes(stage);
export const desktopTitle = run => `Neo Team [${run.key}:${run.startedAt}]`;

// The monitors of this Windows desktop, as Windows names them (\\.\DISPLAY1…).
const SCREENS_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System.Runtime.InteropServices; public class NeoDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][NeoDpi]::SetProcessDPIAware()
ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ id = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } })`;
export function listScreens({ platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve, reject) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCREENS_SCRIPT], { timeout: 15000, windowsHide: true }, (error, stdout) => {
    if (error) return reject(new Error(`No se pudieron leer los monitores: ${error.message}`));
    try {
      const list = [JSON.parse(String(stdout).trim() || '[]')].flat();
      resolve(list.filter(s => typeof s?.id === 'string').map(s => ({ id: s.id, primary: !!s.primary, x: +s.x || 0, y: +s.y || 0, width: +s.width || 0, height: +s.height || 0 })).sort((a, b) => a.x - b.x || a.y - b.y));
    } catch { reject(new Error('No se pudieron leer los monitores.')); }
  }));
}
// Which monitor holds the web and which the application: Windows device names, or null (automatic).
export function screensFrom(input) {
  const id = value => typeof value === 'string' && /^\\\\\.\\DISPLAY\d{1,3}$/.test(value) ? value : null;
  return { web: id(input?.web), app: id(input?.app) };
}

// One guard per stage. Only the browser carrying this run's title and the
// application explicitly identified by the agent are eligible for rearranging.
export class JiraDesktop {
  constructor({ platform = process.platform, launch = spawn } = {}) { Object.assign(this, { platform, launch }); }
  async start(run, onActivity, screens = {}) {
    // Its own notes (arranging windows) go to the step's log, not to the activity summary.
    this.log = entry => onActivity({ kind: 'note', ...entry });
    if (this.platform !== 'win32') {
      this.log({ kind: 'warning', message: 'Control de monitores no disponible: requiere ejecutar Neo Team y el navegador en el mismo escritorio de Windows.' });
      return;
    }
    this.directory = await mkdtemp(join(tmpdir(), 'neo-desktop-'));
    this.file = join(this.directory, 'layout.json');
    this.config = { title: desktopTitle(run), owner: process.pid, application: 0, ...screensFrom(screens), stop: false };
    await writeAtomic(this.file, JSON.stringify(this.config));
    this.child = this.launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./jira-desktop.ps1', import.meta.url)), '-ConfigFile', this.file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => { this.log({ kind: 'warning', message: `No se pudo iniciar el control de ventanas: ${error.message}` }); resolve(); });
      this.child.once('exit', code => { if (!this.config.stop) this.log({ kind: 'warning', message: `El control de ventanas se ha detenido (${code}).` }); resolve(); });
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.log(JSON.parse(line)); } catch { /* Only the helper's structured events. */ }
    });
    this.child.stderr.on('data', data => this.log({ kind: 'warning', message: `Control de ventanas: ${String(data).slice(0, 1500)}` }));
    this.log({ message: 'Monitores activos: navegador maximizado en el monitor de la web; aplicación maximizada en el de reproducir. Se revisará cada 750 ms.' });
  }
  // A new choice of monitors applies at once to the stage in progress.
  async screens(screens) {
    if (!this.config || this.config.stop) return;
    Object.assign(this.config, screensFrom(screens));
    await writeAtomic(this.file, JSON.stringify(this.config));
  }
  async select(processId) {
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Indica el PID real de la aplicación que estás reproduciendo o verificando.');
    if (!this.config || this.config.stop) return 'Control de ventanas no disponible en este equipo.';
    this.config.application = processId;
    await writeAtomic(this.file, JSON.stringify(this.config));
    this.log({ message: `Aplicación registrada para mantenerla maximizada en su monitor · PID ${processId}.` });
    return 'Application registered. The guard will keep its visible windows maximized on the application monitor; check live logs for placement or limitations. Register again if the application restarts with a new PID.';
  }
  async stop() {
    if (!this.directory) return;
    try {
      this.config.stop = true;
      await writeAtomic(this.file, JSON.stringify(this.config));
      let timer;
      await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(() => { this.child?.kill(); resolve(); }, 3000); })]);
      clearTimeout(timer);
    } finally {
      await rm(this.directory, { recursive: true, force: true });
      this.log({ message: 'Control de monitores liberado al terminar la fase.' });
    }
  }
}

export const desktopTool = desktop => ({
  name: 'neo_desktop', skipPermission: true,
  description: 'Identify the actual Windows application process being reproduced or verified. Keeps its windows maximized on the application monitor and the Neo Team browser maximized on its own monitor throughout this stage. Call immediately after launch and again after a restart or when using another application process.',
  parameters: { type: 'object', additionalProperties: false, required: ['processId'], properties: { processId: { type: 'integer', minimum: 1, description: 'Actual application PID obtained from window inspection or Get-Process; never a guessed PID, shell or browser.' } } },
  handler: ({ processId }) => desktop.select(processId),
});
