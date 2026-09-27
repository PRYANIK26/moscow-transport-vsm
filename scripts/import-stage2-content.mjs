#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { validate } from '../apps/api/src/engine.ts';
import {
  stage2ScenarioDefinitions,
  stage2SeedDefinitions,
} from '../apps/api/src/content/stage2-course.ts';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const apply = args.includes('--apply');
const ownerId = value('--owner-id');
const url = process.env.DATABASE_URL;
if (!url || !ownerId || !/^[0-9a-f-]{36}$/i.test(ownerId))
  throw new Error(
    'Set DATABASE_URL and pass --owner-id <author/admin UUID>. Dry run is the default.',
  );
const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
if (!databaseName.includes('test') && !args.includes('--allow-non-test'))
  throw new Error('Refusing a non-test database without --allow-non-test.');
const children = Object.fromEntries(stage2ScenarioDefinitions.map((d) => [d.id, d]));
for (const definition of stage2SeedDefinitions) {
  const check = validate(definition, children);
  if (!check.valid) throw new Error(`${definition.title}: ${JSON.stringify(check.issues)}`);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const owner = await client.query('SELECT role FROM users WHERE id=$1', [ownerId]);
  if (!['admin', 'author'].includes(owner.rows[0]?.role))
    throw new Error('Owner must be an existing author or admin.');
  const planned = [];
  for (const definition of stage2SeedDefinitions) {
    const existing = await client.query(
      'SELECT id,draft,published_version FROM scenarios WHERE id=$1 FOR UPDATE',
      [definition.id],
    );
    const row = existing.rows[0];
    if (row && !isDeepStrictEqual(row.draft, definition))
      throw new Error(
        `Existing draft has changed: ${definition.title} (${definition.id}). No overwrite.`,
      );
    if (row?.published_version) {
      const published = await client.query(
        'SELECT definition FROM scenario_versions WHERE scenario_id=$1 AND version=$2',
        [definition.id, row.published_version],
      );
      if (!isDeepStrictEqual(published.rows[0]?.definition, definition))
        throw new Error(
          `Existing publication differs: ${definition.title} (${definition.id}). No overwrite.`,
        );
      planned.push(`skip ${definition.title}`);
      continue;
    }
    planned.push(`${row ? 'publish existing draft' : 'create + publish'} ${definition.title}`);
    if (!apply) continue;
    if (!row)
      await client.query(
        'INSERT INTO scenarios(id,owner_id,title,kind,draft,revision,published_version) VALUES($1,$2,$3,$4,$5,1,1)',
        [definition.id, ownerId, definition.title, definition.kind, definition],
      );
    else
      await client.query('UPDATE scenarios SET published_version=1,updated_at=now() WHERE id=$1', [
        definition.id,
      ]);
    await client.query(
      'INSERT INTO scenario_versions(scenario_id,version,definition) VALUES($1,1,$2)',
      [definition.id, definition],
    );
  }
  if (apply) await client.query('COMMIT');
  else await client.query('ROLLBACK');
  console.log(`${apply ? 'Applied' : 'Dry run'} on ${databaseName}:\n${planned.join('\n')}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
