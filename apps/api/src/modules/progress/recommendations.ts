import type { ResultDetail, DecisionRecord } from '@vsm/shared';

const label = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
const negative = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value < 0 ? -value : 0;

/** Read from the last 20 immutable results; never infer ability from accumulated XP. */
export function resultRecommendations(results: ResultDetail[]): string[] {
  const recent = results.slice(0, 20);
  if (!recent.length) return ['После первой тренировки здесь появятся советы по вашим решениям.'];
  const decisions = recent.flatMap((result) =>
    Array.isArray(result.history) ? result.history : [],
  );
  const latest = recent[0];
  const output: string[] = [];
  const timeouts = decisions.filter((decision) => decision.kind === 'timeout');
  if (timeouts.length) {
    const last = timeouts[0];
    output.push(
      `В последних ${recent.length} тренировках решений без ответа: ${timeouts.length}. Ситуация «${label(last.situationTitle) || 'без названия'}» завершилась по времени; заранее определите первый шаг.`,
    );
  }
  const dimensions = [
    {
      key: 'loyalty' as const,
      noun: 'сервиса',
      advice: 'проверяйте потребность пассажира и предлагайте понятную альтернативу',
    },
    {
      key: 'safety' as const,
      noun: 'безопасности',
      advice: 'сначала проверяйте условия безопасности',
    },
  ]
    .map((item) => {
      const affected = decisions.filter((decision) => negative(decision.effects?.[item.key]) > 0);
      return {
        ...item,
        count: affected.length,
        loss: affected.reduce((sum, decision) => sum + negative(decision.effects?.[item.key]), 0),
        example: affected[0] as DecisionRecord | undefined,
      };
    })
    .sort((a, b) => b.loss - a.loss);
  for (const item of dimensions) {
    if (!item.count || output.length >= 3) continue;
    const title = label(item.example?.situationTitle) || 'одной из ситуаций';
    output.push(
      `В последних ${recent.length} тренировках было ${item.count} решений со снижением ${item.noun} на ${item.loss} баллов. Например, «${title}»: ${item.advice}.`,
    );
  }
  if (output.length < 3) {
    const loyalty = Number(latest.loyalty),
      safety = Number(latest.safety);
    if (Number.isFinite(loyalty) && Number.isFinite(safety)) {
      if (loyalty < safety)
        output.push(
          `В последней тренировке сервис: ${loyalty}, безопасность: ${safety}. Потренируйте сервисный вариант ответа в следующем сценарии.`,
        );
      else if (safety < loyalty)
        output.push(
          `В последней тренировке безопасность: ${safety}, сервис: ${loyalty}. В следующем сценарии проверьте безопасный порядок действий.`,
        );
      else
        output.push(
          `В последней тренировке сервис и безопасность: по ${loyalty}. Попробуйте другой вариант ответа и сравните разбор.`,
        );
    }
  }
  if (!output.length)
    output.push(
      'Сохранённые результаты пока не содержат подробного разбора решений. Пройдите новый сценарий для предметного совета.',
    );
  return output.slice(0, 3);
}
