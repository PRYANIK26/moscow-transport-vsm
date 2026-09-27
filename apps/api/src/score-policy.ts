import type { Score } from '@vsm/shared';

const keys = ['communication', 'service', 'safety', 'conflict'] as const;

/** Legacy graph weights may be fractional. Round each final competency once, ties toward +infinity. */
export function normalizeCompetencies(
  value: Partial<Score['competencies']> | null | undefined,
): Score['competencies'] {
  return Object.fromEntries(
    keys.map((key) => {
      const raw = value?.[key];
      const rounded = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 0;
      return [key, Object.is(rounded, -0) ? 0 : rounded];
    }),
  ) as Score['competencies'];
}

export function earnedXp(value: Partial<Score['competencies']> | null | undefined): number {
  const competencies = normalizeCompetencies(value);
  return 20 + keys.reduce((total, key) => total + Math.max(0, competencies[key]), 0);
}
