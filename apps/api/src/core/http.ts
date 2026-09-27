import { z } from 'zod';
import { fail } from '../db.js';

export const uuid = z.string().uuid();
export const body = (request: any) => request.body as unknown;
export const params = (request: any) => request.params as Record<string, string>;
export const query = (request: any) => request.query as Record<string, string>;
export const currentUser = (request: any) => {
  const u = request.user;
  if (!u) fail('UNAUTHENTICATED', 'Требуется вход', 401);
  return u;
};
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    fail('VALIDATION_ERROR', 'Некорректные данные запроса', 400, result.error.flatten());
  return result.data as T;
}
