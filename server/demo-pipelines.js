// Pipelines in the example: four pipelines of a fictitious project with their runs,
// steps, logs and code, and a simulated review. Nothing is asked of Azure DevOps or Copilot.
const WEB = { id: '00000000-0000-4000-8000-00000000d3e0', name: 'neo-platform-web', type: 'TfsGit', defaultBranch: 'refs/heads/main' };
const API = { id: '00000000-0000-4000-8000-00000000d3e1', name: 'neo-platform-api', type: 'TfsGit', defaultBranch: 'refs/heads/main' };
const at = (day, time) => `2026-10-${day}T${time}.000Z`;
const run = (id, result, start, finish, extra = {}) => ({ id, number: `2026101${String(id).slice(-1)}.${id % 7 + 1}`, status: result ? 'completed' : 'inProgress', result, sourceBranch: 'refs/heads/main', sourceVersion: `${id}a7c3e91f0b2d4c6e8a0b1c2d3e4f5a6b7c8d9`.slice(0, 40), reason: 'individualCI', queueTime: start, startTime: start, finishTime: finish, requestedFor: 'Lucía Martín', url: null, ...extra });

const PIPELINES = [
  { id: 11, name: 'neo-platform-web CI', path: '\\Web', type: 'yaml', yamlFilename: 'azure-pipelines.yml', repository: WEB, url: null, latest: run(4521, 'failed', at(13, '08:02:10'), at(13, '08:08:31')) },
  { id: 12, name: 'neo-platform-api CI', path: '\\Api', type: 'yaml', yamlFilename: '.azure/ci.yml', repository: API, url: null, latest: run(4519, 'succeeded', at(13, '07:40:00'), at(13, '07:54:12')) },
  { id: 13, name: 'Nightly E2E', path: '\\Web', type: 'yaml', yamlFilename: 'pipelines/e2e.yml', repository: WEB, url: null, latest: run(4523, null, at(13, '09:00:00'), null, { reason: 'schedule' }), lastCompleted: run(4502, 'partiallySucceeded', at(12, '02:00:00'), at(12, '02:41:05'), { reason: 'schedule' }) },
  { id: 14, name: 'Release (clásico)', path: '\\', type: 'classic', yamlFilename: '', repository: WEB, url: null, latest: run(4490, 'canceled', at(10, '16:20:00'), at(10, '17:20:02'), { reason: 'manual' }) },
].map(p => ({ ...p, lastCompleted: p.lastCompleted ?? p.latest }));

let order = 0;
const step = (id, parentId, type, name, result, start, finish, extra = {}) => ({ id, parentId, type, name, order: ++order, state: 'completed', result, startTime: start, finishTime: finish, errorCount: 0, warningCount: 0, logId: null, worker: type === 'Job' ? 'Azure Pipelines 3' : '', issues: [], ...extra });
const t = (day, time) => at(day, time);
const RUNS = {
  11: [
    step('s1', null, 'Stage', 'Build', 'failed', t(13, '08:02:15'), t(13, '08:08:30')),
    step('j1', 's1', 'Job', 'Linux', 'failed', t(13, '08:02:15'), t(13, '08:08:30'), { logId: 2 }),
    step('a1', 'j1', 'Task', 'Checkout neo-platform-web@main', 'succeeded', t(13, '08:02:20'), t(13, '08:02:31'), { logId: 3 }),
    step('a2', 'j1', 'Task', 'Use Node 20.x', 'succeeded', t(13, '08:02:31'), t(13, '08:02:52'), { logId: 4 }),
    step('a3', 'j1', 'Task', 'npm ci', 'succeeded', t(13, '08:02:52'), t(13, '08:04:47'), { logId: 5 }),
    step('a4', 'j1', 'Task', 'npm run lint', 'succeeded', t(13, '08:04:47'), t(13, '08:05:20'), { logId: 6 }),
    step('a5', 'j1', 'Task', 'npm test', 'failed', t(13, '08:05:20'), t(13, '08:08:25'), { logId: 7, errorCount: 1, issues: [{ type: 'error', message: 'Bash exited with code \'1\'.' }] }),
    step('a6', 'j1', 'Task', 'Publish test results', 'skipped', null, null),
  ],
  12: [
    step('s1', null, 'Stage', 'Build', 'succeeded', t(13, '07:40:05'), t(13, '07:54:10')),
    step('j1', 's1', 'Job', 'Build and test', 'succeeded', t(13, '07:40:05'), t(13, '07:54:10'), { logId: 2 }),
    step('b1', 'j1', 'Task', 'Checkout neo-platform-api@main', 'succeeded', t(13, '07:40:10'), t(13, '07:41:02'), { logId: 3 }),
    step('b2', 'j1', 'Task', 'dotnet restore', 'succeeded', t(13, '07:41:02'), t(13, '07:45:20'), { logId: 4 }),
    step('b3', 'j1', 'Task', 'dotnet build', 'succeeded', t(13, '07:45:20'), t(13, '07:48:01'), { logId: 5 }),
    step('b4', 'j1', 'Task', 'dotnet test', 'succeeded', t(13, '07:48:01'), t(13, '07:53:02'), { logId: 6 }),
    step('b5', 'j1', 'Task', 'Publish artifact', 'succeeded', t(13, '07:53:02'), t(13, '07:54:08'), { logId: 7 }),
  ],
  13: [
    step('s1', null, 'Stage', 'E2E', 'succeededWithIssues', t(12, '02:00:05'), t(12, '02:41:00')),
    step('j1', 's1', 'Job', 'Chrome', 'succeededWithIssues', t(12, '02:00:05'), t(12, '02:41:00'), { logId: 2 }),
    step('c1', 'j1', 'Task', 'npm ci', 'succeeded', t(12, '02:00:10'), t(12, '02:02:05'), { logId: 3 }),
    step('c2', 'j1', 'Task', 'Playwright tests', 'succeededWithIssues', t(12, '02:02:05'), t(12, '02:40:30'), { logId: 4, warningCount: 1, issues: [{ type: 'warning', message: '3 tests flaky: passed on retry.' }] }),
  ],
  14: [
    step('s1', null, 'Stage', 'Producción', 'canceled', t(10, '16:20:05'), t(10, '17:20:00')),
    step('j1', 's1', 'Job', 'Desplegar', 'canceled', t(10, '16:20:05'), t(10, '17:20:00'), { logId: 2, errorCount: 1, issues: [{ type: 'error', message: 'The job running on agent Azure Pipelines 2 ran longer than the maximum time of 60 minutes.' }] }),
    step('d1', 'j1', 'Task', 'Esperar a la base de datos', 'canceled', t(10, '16:20:10'), t(10, '17:20:00'), { logId: 3 }),
  ],
};
const HISTORY = {
  11: [[4521, 'failed', 381], [4517, 'succeeded', 352], [4511, 'succeeded', 349], [4506, 'succeeded', 360]],
  12: [[4519, 'succeeded', 852], [4512, 'succeeded', 861], [4507, 'succeeded', 840]],
  13: [[4502, 'partiallySucceeded', 2465], [4496, 'partiallySucceeded', 2410], [4488, 'succeeded', 2290]],
  14: [[4490, 'canceled', 3602], [4470, 'succeeded', 412]],
};
const LOGS = {
  '11:7': ['> neo-platform-web@3.4.0 test', '> node --test tests/', '', '▶ toCsv', '  ✔ escapes quotes (1.2ms)', '  ✖ rounds amounts to two decimals (3.4ms)', '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', "    + actual - expected", "    + '10.12'", "    - '10.13'", '        at TestContext.<anonymous> (tests/csv.test.js:9:10)', '▶ exportReport', '  ✖ exports the report of the period (8.1ms)', '    Error: amount must have two decimals', '        at toCsv (src/reports/csv.js:4:11)', 'ℹ tests 14', 'ℹ pass 12', 'ℹ fail 2', '##[error]Bash exited with code \'1\'.'],
  '11:5': ['added 1210 packages in 1m 52s', 'npm warn deprecated inflight@1.0.6'],
  '12:4': ['Determining projects to restore...', 'Restored /src/Neo.Api/Neo.Api.csproj (in 2.12 min).', 'Restored /tests/Neo.Api.Tests/Neo.Api.Tests.csproj (in 2.05 min).'],
  '12:6': ['Starting test execution, please wait...', 'A total of 1 test files matched the specified pattern.', 'Passed!  - Failed: 0, Passed: 412, Skipped: 0, Total: 412, Duration: 4 m 52 s'],
  '13:4': ['Running 186 tests using 1 worker', '  ✓ facturas › exporta a Excel (12.3s)', '  ✘ clientes › filtro por provincia (retry #1) (30.0s)', '  ✓ clientes › filtro por provincia (retry #2) (11.8s)', '  3 flaky', '  183 passed (38.4m)'],
  '14:3': ['Esperando a que la base de datos de producción acepte conexiones…', 'Intento 1: connection refused', 'Intento 2: connection refused', '…', 'Intento 360: connection refused', '##[error]The operation was canceled.'],
};
const FILES = {
  [WEB.id]: {
    'azure-pipelines.yml': "trigger:\n  - main\n\npool:\n  vmImage: ubuntu-latest\n\nsteps:\n  - checkout: self\n  - task: NodeTool@0\n    inputs:\n      versionSpec: '20.x'\n  - script: npm ci\n    displayName: npm ci\n  - script: npm run lint\n    displayName: npm run lint\n  - script: npm test\n    displayName: npm test\n  - task: PublishTestResults@2\n    inputs:\n      testResultsFiles: '**/junit.xml'\n",
    'pipelines/e2e.yml': "schedules:\n  - cron: '0 2 * * *'\n    branches: { include: [main] }\n\npool:\n  vmImage: ubuntu-latest\n\nsteps:\n  - script: npm ci\n  - script: npx playwright test --workers=1 --retries=2\n    displayName: Playwright tests\n",
    'package.json': '{\n  "name": "neo-platform-web",\n  "version": "3.4.0",\n  "scripts": {\n    "lint": "eslint src",\n    "test": "node --test tests/"\n  }\n}\n',
    'src/reports/csv.js': "export function toCsv(rows) {\n  return rows.map(row => {\n    const amount = Math.floor(row.amount * 100) / 100;\n    if (!/^\\d+\\.\\d{2}$/.test(amount.toFixed(2))) throw new Error('amount must have two decimals');\n    return [row.name, amount.toFixed(2)].join(';');\n  }).join('\\n');\n}\n",
    'tests/csv.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { toCsv } from '../src/reports/csv.js';\n\ntest('escapes quotes', () => {});\n\ntest('rounds amounts to two decimals', () => {\n  const csv = toCsv([{ name: 'A', amount: 10.125 }]);\n  assert.equal(csv.split(';')[1], '10.13');\n});\n",
  },
  [API.id]: {
    '.azure/ci.yml': "trigger:\n  - main\n\npool:\n  vmImage: ubuntu-latest\n\nsteps:\n  - checkout: self\n  - script: dotnet restore\n    displayName: dotnet restore\n  - script: dotnet build --no-restore -c Release\n    displayName: dotnet build\n  - script: dotnet test --no-build -c Release\n    displayName: dotnet test\n  - publish: $(Build.ArtifactStagingDirectory)\n    artifact: api\n    displayName: Publish artifact\n",
    'src/Neo.Api/Neo.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n',
  },
};
const CLASSIC_YAML = "# Exported from the classic definition\njobs:\n- job: Desplegar\n  timeoutInMinutes: 60\n  steps:\n  - script: until nc -z $(DbHost) 5432; do sleep 10; done\n    displayName: Esperar a la base de datos\n";

export class DemoPipelineGateway {
  async pipelines() { return structuredClone(PIPELINES); }
  async repositories() { return [WEB, API].map(({ id, name, defaultBranch }) => ({ id, name, defaultBranch })); }
  async run(_config, definitionId) {
    const pipeline = PIPELINES.find(p => p.id === definitionId);
    if (!pipeline) throw Object.assign(new Error('El pipeline ya no existe.'), { status: 404 });
    const last = pipeline.lastCompleted;
    return structuredClone({
      run: { ...last, validation: [], pool: 'Azure Pipelines' }, repository: pipeline.repository,
      definition: { id: pipeline.id, name: pipeline.name, path: pipeline.path, type: pipeline.type, yamlFilename: pipeline.yamlFilename, repository: pipeline.repository, url: null },
      yaml: pipeline.type === 'classic' ? CLASSIC_YAML : null, records: RUNS[definitionId],
      history: HISTORY[definitionId].map(([id, result, seconds]) => ({ ...last, id, number: `${last.number.split('.')[0]}.${id % 7 + 1}`, result, finishTime: new Date(Date.parse(last.startTime) + seconds * 1000).toISOString() })),
    });
  }
  async log(_config, buildId, logId, { tail, startLine = 1, endLine } = {}) {
    const definition = PIPELINES.find(p => p.lastCompleted.id === buildId)?.id;
    const lines = LOGS[`${definition}:${logId}`] ?? ['(sin salida)'];
    const from = tail ? Math.max(1, lines.length - tail + 1) : startLine, to = tail ? lines.length : Math.min(lines.length, endLine ?? lines.length);
    return { logId, lineCount: lines.length, startLine: from, lines: lines.slice(from - 1, to) };
  }
  async item(_config, { repositoryId, path, folder }) {
    const files = FILES[repositoryId] ?? {}, clean = path.replace(/^\/+|\/+$/g, '');
    if (!folder) return files[clean] !== undefined ? { path, text: files[clean], size: files[clean].length } : { path, error: 'HTTP 404: el archivo no existe.' };
    const prefix = clean ? `${clean}/` : '', entries = new Map();
    for (const file of Object.keys(files).filter(f => f.startsWith(prefix))) {
      const [first, ...rest] = file.slice(prefix.length).split('/');
      entries.set(first, { path: `/${prefix}${first}`, folder: rest.length > 0 });
    }
    return { path, entries: [...entries.values()] };
  }
}

// One simulated review per pipeline of the example, found by its name in the prompt.
const DEMO_ANALYSES = {
  'neo-platform-web CI': {
    summary: 'Fallan 2 pruebas de `npm test`: `toCsv` redondea los importes hacia abajo con `Math.floor`, así que 10,125 sale 10,12 en lugar de 10,13. No es intermitente: falla igual en cada ejecución desde el último cambio de `src/reports/csv.js`.',
    cause: '`toCsv` trunca el importe (`Math.floor(amount * 100) / 100`) en lugar de redondearlo, y la prueba «rounds amounts to two decimals» espera 10.13.', category: 'code',
    findings: [
      { title: 'Redondear el importe en lugar de truncarlo', priority: 'high', file: 'src/reports/csv.js', line: 3, body: 'El registro de `npm test` (líneas 6-10) muestra `10.12` frente a `10.13`. `Math.floor` descarta el tercer decimal; usa un redondeo que corrija el error de coma flotante.', fix: 'const amount = Math.round((row.amount + Number.EPSILON) * 100) / 100;' },
      { title: 'Publicar los resultados de las pruebas aunque fallen', priority: 'medium', file: 'azure-pipelines.yml', line: 18, body: 'El paso «Publish test results» se omitió porque `npm test` falló: sin él, la pestaña Tests de la ejecución no muestra qué prueba falla.', fix: "  - task: PublishTestResults@2\n    condition: succeededOrFailed()\n    inputs:\n      testResultsFiles: '**/junit.xml'" },
    ],
  },
  'neo-platform-api CI': {
    summary: 'La ejecución tarda 14 min y casi un tercio es `dotnet restore` (4 min 18 s) sin caché. Las pruebas (5 min) se ejecutan en un solo trabajo.',
    findings: [
      { title: 'Cachear los paquetes NuGet', priority: 'high', file: '.azure/ci.yml', line: 9, body: '`dotnet restore` descarga todos los paquetes en cada ejecución (registro: 2,12 min por proyecto). Con `Cache@2` sobre `~/.nuget/packages` y la clave del lock file, una ejecución sin cambios de dependencias lo reduce a segundos.', fix: "  - task: Cache@2\n    inputs:\n      key: 'nuget | \"$(Agent.OS)\" | **/packages.lock.json'\n      path: $(NUGET_PACKAGES)\n  - script: dotnet restore --locked-mode", saving: '~3 min' },
      { title: 'Clonar solo el último commit', priority: 'low', file: '.azure/ci.yml', line: 8, body: 'El checkout tarda 52 s porque descarga todo el historial. El pipeline no lo necesita.', fix: '  - checkout: self\n    fetchDepth: 1', saving: '~40 s' },
    ],
  },
  'Nightly E2E': {
    summary: 'Las 186 pruebas pasan, pero 3 solo al reintentar, y por eso la ejecución termina como parcial. Además, todo corre con un solo worker durante 38 min.',
    cause: 'La prueba «clientes › filtro por provincia» espera una respuesta que a veces tarda más de 30 s: falla al primer intento y pasa en el reintento.', category: 'intermittent',
    findings: [
      { title: 'Esperar a la lista filtrada en lugar de a un tiempo fijo', priority: 'high', file: null, line: null, body: 'El registro muestra el primer intento agotando los 30 s. Espera al elemento que pinta el filtro (`await expect(row).toBeVisible()`) en lugar del tiempo de espera general.', fix: null },
      { title: 'Repartir las pruebas en varios workers', priority: 'medium', file: 'pipelines/e2e.yml', line: 10, body: '`--workers=1` serializa las 186 pruebas. Con 4 workers en el mismo agente la ejecución bajaría a unos 12 min.', fix: '  - script: npx playwright test --workers=4 --retries=2' },
    ],
  },
  'Release (clásico)': {
    summary: 'La ejecución se canceló al llegar al límite de 60 min: el paso «Esperar a la base de datos» reintentó 360 veces sin que la base de datos aceptara conexiones.',
    cause: 'La base de datos de producción no era accesible desde el agente (connection refused) y el bucle de espera no tiene límite propio.', category: 'infrastructure',
    findings: [
      { title: 'Limitar la espera y fallar con un mensaje claro', priority: 'high', file: null, line: null, body: 'Sin límite, el paso consume todo el tiempo del trabajo. Con un máximo de intentos falla en minutos y dice qué no responde.', fix: 'for i in $(seq 1 30); do nc -z $(DbHost) 5432 && exit 0; sleep 10; done\necho "##[error]$(DbHost):5432 no acepta conexiones"; exit 1' },
    ],
  },
};
// The simulated review reads the YAML with its tools, as Copilot would.
export class DemoPipelineAnalyst {
  async status() { return { isAuthenticated: true, login: 'ejemplo', host: null, authType: 'demo', models: [], message: null }; }
  async ask({ prompt = '', tools = [], onProgress = () => {} }) {
    onProgress({ message: 'Simulando la revisión de GitHub Copilot…' });
    const [name, analysis] = Object.entries(DEMO_ANALYSES).find(([pipeline]) => prompt.includes(`«${pipeline}»`)) ?? Object.entries(DEMO_ANALYSES)[0];
    const file = analysis.findings.find(f => f.file)?.file, read = tools.find(t => t.name === 'neo_read_file');
    if (file && read) await read.handler({ path: file });
    return { text: JSON.stringify(analysis), login: 'ejemplo', model: `simulado (${name})`, usage: {} };
  }
  async abort() {}
}
