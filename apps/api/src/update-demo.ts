import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { pool, emit } from './db.js';
import { demoDefinitions } from './seed.js';
import { validate } from './engine.js';

const demoAuthor = '33333333-3333-4333-8333-333333333302';
/** Publishes a new version only for untouched synthetic seed records. */
export async function updateDemo(apply = false) {
  const children = Object.fromEntries(
    demoDefinitions.filter((d) => d.kind === 'scenario').map((d) => [d.id, d]),
  );
  for (const d of demoDefinitions) {
    const checked = validate(d, children);
    if (!checked.valid)
      throw new Error(`Invalid packaged demo ${d.id}: ${JSON.stringify(checked.issues)}`);
  }
  const report: { id: string; action: string; version?: number }[] = [];
  for (const definition of demoDefinitions) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(
        'SELECT s.*,v.definition AS published FROM scenarios s JOIN scenario_versions v ON v.scenario_id=s.id AND v.version=s.published_version WHERE s.id=$1 FOR UPDATE OF s',
        [definition.id],
      );
      const row = r.rows[0];
      if (!row) {
        report.push({ id: definition.id, action: 'missing' });
        await c.query('COMMIT');
        continue;
      }
      if (isDeepStrictEqual(row.published, definition)) {
        report.push({ id: definition.id, action: 'current', version: row.published_version });
        await c.query('COMMIT');
        continue;
      }
      if (
        row.owner_id !== demoAuthor ||
        row.revision !== 1 ||
        !isDeepStrictEqual(row.draft, row.published)
      ) {
        report.push({
          id: definition.id,
          action: 'skipped-authored',
          version: row.published_version,
        });
        await c.query('COMMIT');
        continue;
      }
      const next = row.published_version + 1;
      if (apply) {
        await c.query(
          'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,$2,$3)',
          [definition.id, next, definition],
        );
        await c.query(
          'UPDATE scenarios SET draft=$2,title=$3,revision=revision+1,published_version=$4,updated_at=now() WHERE id=$1',
          [definition.id, definition, definition.title, next],
        );
        await emit(c, 'notifications', 'publication', `publication:${definition.id}:${next}`, {
          scenarioId: definition.id,
          title: definition.title,
        });
      }
      report.push({
        id: definition.id,
        action: apply ? 'published' : 'would-publish',
        version: next,
      });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes('--apply');
  updateDemo(apply)
    .then(async (report) => {
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', report }, null, 2));
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      process.exitCode = 1;
      await pool.end();
    });
}
