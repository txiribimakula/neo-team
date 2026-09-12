import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { upgradeDemoHierarchy } from './demo.js';

export class LocalStore {
  constructor(directory) { this.directory = directory; this.file = join(directory, 'workspace.json'); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
      if (this.data.schema !== 1 || !Number.isInteger(this.data.version) || !['azure', 'demo'].includes(this.data.mode)) throw new Error('Formato de planificación no compatible');
      const next = structuredClone(this.data);
      if (upgradeDemoHierarchy(next.demo)) await this.save(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`No se pudo leer ${this.file}. Se conserva el archivo original. ${error.message}`);
      this.data = { schema: 1, version: 0, mode: 'azure', config: null, azure: null, demo: null };
    }
  }
  async save(next) {
    next.version = this.data.version + 1;
    const temp = join(this.directory, `.workspace-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await rename(temp, this.file);
      this.data = next;
    } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
  }
}
