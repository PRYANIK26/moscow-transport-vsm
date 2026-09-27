import type { CommunicationObservation } from '@vsm/shared';

export const COMMUNICATION_POLICY_VERSION = 'demo-explicit-rudeness-1';

/** Deliberately narrow, reviewable local rule. Only direct address to the passenger qualifies. */
export function explicitRudeness(text: string, messageId: string): CommunicationObservation | null {
  const chunks = text.match(/[^.!?\n]+[.!?]?/gu) ?? [];
  for (const chunk of chunks) {
    const quote = chunk.trim();
    if (
      !quote ||
      /[«»"“”]/u.test(quote) ||
      /(?:^|\s)(?:не\s+(?:говорю|считаю|называю)|цитирую|сказал[аи]?)(?:\s|$)/iu.test(quote)
    )
      continue;
    const direct =
      /(?:^|[\s,])(?:(?:ты|тебя|вы|вас)\s+(?:идиот[а-я]*|дурак[а-я]*|туп[а-я]*|дебил[а-я]*|придур[а-я]*|мудак[а-я]*|сук[а-я]*)|(?:заткнись|заткнитесь)|(?:иди|пош[её]л[а-я]*)\s+на\s*х[уе][йя])(?:[\s,.!?]|$)/iu.exec(
        quote,
      );
    if (direct)
      return {
        kind: 'explicit_rudeness',
        evidence: direct[0],
        messageId,
        policyVersion: COMMUNICATION_POLICY_VERSION,
      };
  }
  return null;
}
