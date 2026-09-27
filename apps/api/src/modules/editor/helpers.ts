import { pool, fail } from '../../db.js';
import { graphShape } from '../../graph-shape.js';

export const isEditor = (u: any) => u.role === 'author' || u.role === 'admin';
export async function editorRow(id: string, u: any) {
  const r = await pool.query('SELECT * FROM scenarios WHERE id=$1', [id]);
  const row = r.rows[0];
  if (!row || (u.role !== 'admin' && row.owner_id !== u.id))
    fail('NOT_FOUND', 'Сценарий не найден', 404);
  return row;
}
export function shape(value: unknown, id: string, kind: string) {
  const checked = graphShape(value);
  const definition = checked.definition;
  if (!definition) fail('VALIDATION_ERROR', 'Неверная структура сценария', 400, checked.result);
  if (definition!.id !== id || definition!.kind !== kind)
    fail('VALIDATION_ERROR', 'ID или тип сценария не совпадают с черновиком', 400);
  return definition!;
}
