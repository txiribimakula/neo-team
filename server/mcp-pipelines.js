// Pipelines of a project, read through the local MCP: each pipeline with its last
// run, the detail of a run (steps, errors and recent history), the lines of its logs
// and the files of a repository at a commit. Nothing is queued, retried or changed.
import { z } from 'zod';
import { readText } from './pr-content.js';

const STATUS = { 0: 'none', 1: 'inProgress', 2: 'completed', 4: 'cancelling', 8: 'postponed', 32: 'notStarted' };
const RESULT = { 0: 'none', 2: 'succeeded', 4: 'partiallySucceeded', 8: 'failed', 32: 'canceled' };
const TASK_RESULT = { 0: 'succeeded', 1: 'succeededWithIssues', 2: 'failed', 3: 'canceled', 4: 'skipped', 5: 'abandoned' };
const RECORD_STATE = { 0: 'pending', 1: 'inProgress', 2: 'completed' };
const REASON = { 1: 'manual', 2: 'individualCI', 4: 'batchedCI', 8: 'schedule', 32: 'userCreated', 64: 'validateShelveset', 128: 'checkInShelveset', 256: 'pullRequest', 512: 'buildCompletion', 1024: 'resourceTrigger', 2048: 'triggered' };
// Enums come as numbers once deserialized, or as their names when they are not.
const named = (names, value) => value === undefined || value === null ? null : typeof value === 'string' ? value.charAt(0).toLowerCase() + value.slice(1) : names[value] ?? String(value);
const iso = value => value ? new Date(value).toISOString() : null;
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const run = b => b ? {
  id: b.id, number: b.buildNumber ?? String(b.id), status: named(STATUS, b.status), result: named(RESULT, b.result),
  sourceBranch: b.sourceBranch ?? '', sourceVersion: b.sourceVersion ?? '', reason: named(REASON, b.reason),
  queueTime: iso(b.queueTime), startTime: iso(b.startTime), finishTime: iso(b.finishTime),
  requestedFor: b.requestedFor?.displayName ?? '', url: b._links?.web?.href ?? null,
} : null;
const repository = r => r ? { id: r.id ?? null, name: r.name ?? '', type: r.type ?? '', defaultBranch: r.defaultBranch ?? '' } : null;
// Process type 2 is YAML; the rest (designer) keep their steps in the definition.
const process = d => d?.process?.type === 2 || d?.process?.yamlFilename ? { type: 'yaml', yamlFilename: d.process.yamlFilename ?? '' } : { type: 'classic', yamlFilename: '' };

export function configurePipelineTools(server, connectionProvider) {
  server.tool('neo_pipelines', 'List the build pipelines of a project with their latest run and their latest completed run.', {
    project: z.string().min(1).max(200),
  }, async ({ project }) => {
    const build = await (await connectionProvider()).getBuildApi();
    const definitions = [];
    let token;
    do {
      const page = await build.getDefinitions(project, undefined, undefined, undefined, 3, 500, token, undefined, undefined, undefined, undefined, undefined, true, true);
      definitions.push(...(page ?? []));
      token = page?.continuationToken;
    } while (token && definitions.length < 2000);
    return json(definitions.filter(d => d.queueStatus !== 2).map(d => ({
      id: d.id, name: d.name ?? String(d.id), path: d.path ?? '\\', ...process(d), repository: repository(d.repository),
      url: d._links?.web?.href ?? null, latest: run(d.latestBuild), lastCompleted: run(d.latestCompletedBuild),
    })));
  });
  // A run (the given one, or the latest completed of the pipeline) with its timeline,
  // the definition it ran and the recent completed runs of the same pipeline.
  server.tool('neo_pipeline_run', 'Read a pipeline run: its steps with their results, errors and durations, and the recent completed runs of the pipeline.', {
    project: z.string().min(1).max(200), definitionId: z.number().int().positive(), buildId: z.number().int().positive().optional(), history: z.number().int().min(1).max(30),
  }, async ({ project, definitionId, buildId, history }) => {
    const build = await (await connectionProvider()).getBuildApi();
    const recent = await build.getBuilds(project, [definitionId], undefined, undefined, undefined, undefined, undefined, undefined, 2, undefined, undefined, undefined, history, undefined, undefined, undefined, 3) ?? [];
    const chosen = buildId ? await build.getBuild(project, buildId) : recent[0];
    if (!chosen) return json({ run: null, history: [] });
    if (chosen.definition?.id !== definitionId) throw new Error(`La ejecución ${buildId} no es del pipeline ${definitionId}.`);
    const definition = await build.getDefinition(project, definitionId);
    const kind = process(definition);
    // A designer pipeline has no YAML file: Azure DevOps exports its steps as YAML.
    const yaml = kind.type === 'classic' ? await build.getDefinitionYaml(project, definitionId).then(y => y?.yaml ?? null, () => null) : null;
    const timeline = await build.getBuildTimeline(project, chosen.id).catch(() => null);
    const records = (timeline?.records ?? []).slice(0, 1000).map(r => ({
      id: r.id, parentId: r.parentId ?? null, type: r.type ?? '', name: r.name ?? '', order: r.order ?? 0,
      state: named(RECORD_STATE, r.state), result: named(TASK_RESULT, r.result), startTime: iso(r.startTime), finishTime: iso(r.finishTime),
      errorCount: r.errorCount ?? 0, warningCount: r.warningCount ?? 0, logId: r.log?.id ?? null, worker: r.workerName ?? '',
      issues: (r.issues ?? []).slice(0, 10).map(i => ({ type: i.type === 1 || i.type === 'error' ? 'error' : 'warning', message: String(i.message ?? '').slice(0, 1500) })),
    }));
    return json({
      run: { ...run(chosen), validation: (chosen.validationResults ?? []).map(v => String(v.message ?? '')).filter(Boolean).slice(0, 10), pool: chosen.queue?.pool?.name ?? chosen.queue?.name ?? '' },
      repository: repository(chosen.repository), definition: { id: definitionId, name: definition?.name ?? chosen.definition?.name ?? '', path: definition?.path ?? '\\', ...kind, repository: repository(definition?.repository), url: definition?._links?.web?.href ?? null },
      yaml, records, history: recent.map(run),
    });
  });
  server.tool('neo_pipeline_log', 'Read lines of the log of a step of a pipeline run, or its last lines.', {
    project: z.string().min(1).max(200), buildId: z.number().int().positive(), logId: z.number().int().positive(),
    startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(), tail: z.number().int().min(1).max(5000).optional(),
  }, async ({ project, buildId, logId, startLine, endLine, tail }) => {
    const build = await (await connectionProvider()).getBuildApi();
    const logs = await build.getBuildLogs(project, buildId) ?? [];
    const log = logs.find(l => l.id === logId);
    if (!log) throw new Error(`La ejecución ${buildId} no tiene el registro ${logId}.`);
    const total = log.lineCount ?? 0;
    const from = tail ? Math.max(1, total - tail + 1) : Math.max(1, startLine ?? 1);
    const to = Math.min(total || Infinity, tail ? total : endLine ?? from + 1999, from + 4999);
    const lines = total && from > total ? [] : await build.getBuildLogLines(project, buildId, logId, from, to) ?? [];
    return json({ logId, lineCount: total, startLine: from, lines: lines.map(line => String(line).slice(0, 2000)) });
  });
  // The code a run used: a file or a folder of an Azure Repos repository at a commit (or branch).
  server.tool('neo_git_item', 'Read a file, or list a folder, of a Git repository at a commit or branch.', {
    project: z.string().min(1).max(200), repositoryId: z.string().min(1).max(200), path: z.string().min(1).max(1000),
    version: z.string().max(250).optional(), versionType: z.enum(['commit', 'branch']).optional(), folder: z.boolean(), maxBytes: z.number().int().min(1000).max(2000000),
  }, async ({ project, repositoryId, path, version, versionType = 'commit', folder, maxBytes }) => {
    const git = await (await connectionProvider()).getGitApi();
    const descriptor = version ? { version: versionType === 'branch' ? version.replace(/^refs\/heads\//, '') : version, versionType: versionType === 'branch' ? 0 : 2 } : undefined;
    if (folder) {
      const items = await git.getItems(repositoryId, project, path, 1, false, false, false, false, descriptor) ?? [];
      return json({ path, entries: items.filter(i => i.path !== path && i.path?.replace(/\/$/, '') !== path.replace(/\/$/, '')).slice(0, 1000).map(i => ({ path: i.path, folder: !!i.isFolder })) });
    }
    const content = await readText(await git.getItemText(repositoryId, path, project, undefined, undefined, undefined, undefined, false, descriptor, true), maxBytes).catch(error => ({ error: error.message }));
    return json({ path, ...content });
  });
}
