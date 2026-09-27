import type { SourceRef } from '@vsm/shared';
import { scenarios } from './original-scenarios.js';

/** Selected training text from the supplied simulator, without publishing source archives. */
export const trainingMaterials: Record<
  string,
  Array<{ title: string; text: string; source: SourceRef }>
> = Object.fromEntries(
  scenarios.map((scenario, index) => [
    `00000000-0000-4000-8000-${String(1001 + index).padStart(12, '0')}`,
    [
      {
        title: scenario.title,
        text: scenario.rules.join('\n'),
        source: { document: scenario.sources[0].title, section: scenario.sources[0].locator },
      },
    ],
  ]),
);
