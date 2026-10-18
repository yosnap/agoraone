import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesDiscovery } from './hermes-catalog';
import { jobDetail, manageCard, manageJob, ManageError } from './hermes-manage';
import { readActivity } from './hermes-activity';

// Real Hermes functions on fictitious profiles: the user's scheduled tasks and board are never touched.
const python = join(homedir(), '.hermes/hermes-agent/venv/bin/python');

test('tareas y kanban: se gestionan con Hermes, solo las del propio perfil y sin perder líneas ocultas',
  { skip: !existsSync(python) && 'Hermes no instalado', timeout: 180_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agora-manage-')));
    for (const name of ['alpha', 'beta']) mkdirSync(join(root, 'profiles', name), { recursive: true });
    writeFileSync(join(root, 'profiles/alpha/SOUL.md'), 'Soy alpha.');
    writeFileSync(join(root, 'profiles/beta/SOUL.md'), 'Soy beta.');
    const discovery = new HermesDiscovery({ root, installation: join(homedir(), '.hermes/hermes-agent'), python, source: 'test' });
    const [alpha, beta] = discovery.scan().profiles;
    const rejects = (promise: Promise<unknown>, status: number) => assert.rejects(promise, error => error instanceof ManageError && error.status === status);
    try {
      const created = await manageJob(discovery, alpha.id, null, { name: 'Resumen', schedule: 'every 2h', prompt: 'Resume mis notas\napi_key: CANARY_JOB_KEY' });
      const jobId = String(created.job);
      assert.ok(existsSync(join(root, 'profiles/alpha/cron/jobs.json')), 'en el almacén del propio perfil');
      assert.equal(existsSync(join(root, 'profiles/beta/cron/jobs.json')), false);
      const detail = await jobDetail(discovery, alpha.id, jobId);
      assert.doesNotMatch(detail.prompt, /CANARY/); assert.equal(detail.hidden, 1);
      await manageJob(discovery, alpha.id, jobId, { action: 'update', prompt: detail.prompt.replace('Resume', 'Ordena'), revision: detail.revision });
      // Instructions changed since they were opened: the old revision no longer saves.
      await rejects(manageJob(discovery, alpha.id, jobId, { action: 'update', prompt: 'pisado', revision: detail.revision }), 409);
      const stored = readFileSync(join(root, 'profiles/alpha/cron/jobs.json'), 'utf8');
      assert.match(stored, /Ordena mis notas/); assert.match(stored, /CANARY_JOB_KEY/, 'la línea oculta vuelve del almacén');
      await manageJob(discovery, alpha.id, jobId, { action: 'pause' });
      let job = readActivity(root, [{ id: alpha.id, name: 'alpha', home: join(root, 'profiles/alpha') }]).profiles[alpha.id].jobs?.[0];
      assert.equal(job?.id, jobId); assert.equal(job?.enabled, false);
      await manageJob(discovery, alpha.id, jobId, { action: 'resume' });
      await manageJob(discovery, alpha.id, jobId, { action: 'run' });
      // «Run now» only marks it for the gateway: nothing runs here, and nothing is written outside the profile.
      const marked = JSON.parse(readFileSync(join(root, 'profiles/alpha/cron/jobs.json'), 'utf8'));
      const record = (Array.isArray(marked) ? marked : marked.jobs).find((item: { id: string }) => item.id === jobId);
      assert.equal(record.last_run_at ?? null, null, 'no se ha ejecutado');
      assert.ok(record.manual_run_at, 'queda marcada para el siguiente ciclo');
      // Importing Hermes creates the default home's empty folders (as any hermes command does); nothing ran there.
      assert.equal(existsSync(join(root, 'state.db')), false, 'sin sesión de agente');
      assert.deepEqual(readdirSync(join(root, 'cron')).filter(name => /executions|jobs\.json/.test(name)), [], 'sin ejecuciones');
      const once = String((await manageJob(discovery, alpha.id, null, { name: 'Recordatorio', schedule: 'in 30m', prompt: 'Recuérdamelo' })).job);
      assert.equal((await jobDetail(discovery, alpha.id, once)).once, true);
      await manageJob(discovery, alpha.id, once, { action: 'update', name: 'Recordatorio editado' });
      await manageJob(discovery, alpha.id, once, { action: 'remove' });
      await rejects(manageJob(discovery, beta.id, jobId, { action: 'remove' }), 404);
      await manageJob(discovery, alpha.id, jobId, { action: 'remove' });
      job = readActivity(root, [{ id: alpha.id, name: 'alpha', home: join(root, 'profiles/alpha') }]).profiles[alpha.id].jobs?.[0];
      assert.equal(job, undefined);
      await assert.rejects(manageJob(discovery, alpha.id, null, { name: 'Mala', schedule: 'cuando quieras', prompt: 'x' }),
        error => error instanceof ManageError && error.status === 400 && /no reconoce ese horario/.test(error.message), 'el error llega en castellano');

      const card = String((await manageCard(discovery, alpha.id, null, { title: 'Revisar presupuesto', body: 'detalle' })).card);
      const board = () => readActivity(root, [{ id: alpha.id, name: 'alpha', home: join(root, 'profiles/alpha') }]).profiles[alpha.id].board;
      assert.equal(board()?.open[0]?.id, card);
      await rejects(manageCard(discovery, beta.id, card, { action: 'archive' }), 404);
      await manageCard(discovery, alpha.id, card, { action: 'comment', body: 'Desde la prueba' });
      await manageCard(discovery, alpha.id, card, { action: 'block', reason: 'Esperando datos' });
      await manageCard(discovery, alpha.id, card, { action: 'unblock' });
      await manageCard(discovery, alpha.id, card, { action: 'complete' });
      assert.equal(board()?.open.length, 0);
      await rejects(manageCard(discovery, alpha.id, 'no-existe', { action: 'complete' }), 404);
      await rejects(manageJob(discovery, 'profile-' + '0'.repeat(24), null, { name: 'x', schedule: 'every 1h', prompt: 'x' }), 404);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
