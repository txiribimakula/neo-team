import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { writeAtomic } from './jira.js';

export const desktopStage = stage => ['reproduce', 'verify'].includes(stage);
export const desktopTitle = run => `Neo Team [${run.key}:${run.startedAt}]`;

// One guard per stage. Only the browser carrying this run's title and the
// application explicitly identified by the agent are eligible for rearranging.
export class JiraDesktop {
  constructor({ platform = process.platform, launch = spawn } = {}) { Object.assign(this, { platform, launch }); }
  async start(run, onActivity) {
    this.log = onActivity;
    if (this.platform !== 'win32') {
      this.log({ kind: 'warning', message: 'Distribución de ventanas no disponible: requiere ejecutar Neo Team y el navegador en el mismo escritorio de Windows.' });
      return;
    }
    this.directory = await mkdtemp(join(tmpdir(), 'neo-desktop-'));
    this.file = join(this.directory, 'layout.json');
    this.config = { title: desktopTitle(run), owner: process.pid, application: 0, stop: false };
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
    this.log({ message: 'Distribución activa: navegador al mínimo ancho a la izquierda; aplicación a la derecha. Se revisará cada 750 ms.' });
  }
  async select(processId) {
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Indica el PID real de la aplicación que estás reproduciendo o verificando.');
    if (!this.config || this.config.stop) return 'Control de ventanas no disponible en este equipo.';
    this.config.application = processId;
    await writeAtomic(this.file, JSON.stringify(this.config));
    this.log({ message: `Aplicación registrada para mantenerla a la derecha · PID ${processId}.` });
    return 'Application registered. The guard will keep its visible windows on the right; check live logs for placement or limitations. Register again if the application restarts with a new PID.';
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
      this.log({ message: 'Distribución de ventanas liberada al terminar la fase.' });
    }
  }
}

export const desktopTool = desktop => ({
  name: 'neo_desktop', skipPermission: true,
  description: 'Identify the actual Windows application process being reproduced or verified. Keeps its windows on the right and the Neo Team browser at minimum width on the left throughout this stage. Call immediately after launch and again after a restart or when using another application process.',
  parameters: { type: 'object', additionalProperties: false, required: ['processId'], properties: { processId: { type: 'integer', minimum: 1, description: 'Actual application PID obtained from window inspection or Get-Process; never a guessed PID, shell or browser.' } } },
  handler: ({ processId }) => desktop.select(processId),
});
