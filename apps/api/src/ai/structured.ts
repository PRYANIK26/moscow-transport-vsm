import { z } from 'zod';

export const aiReady = () =>
  !!(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
export async function structured<T extends z.ZodType>(
  schema: T,
  name: string,
  instruction: string,
  input: unknown,
  maxTokens = 2500,
): Promise<z.infer<T>> {
  if (!aiReady())
    throw new Error(
      'Для помощника нужны YANDEX_API_KEY и YANDEX_FOLDER_ID на сервере.',
    );
  const response = await fetch(
    'https://ai.api.cloud.yandex.net/v1/chat/completions',
    {
      method: 'POST',
      signal: AbortSignal.timeout(25_000),
      headers: {
        Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        'OpenAI-Project': process.env.YANDEX_FOLDER_ID!,
        'Content-Type': 'application/json',
        'x-data-logging-enabled': 'false',
      },
      body: JSON.stringify({
        model: `gpt://${process.env.YANDEX_FOLDER_ID}/${process.env.YANDEX_MODEL || 'yandexgpt/rc'}`,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name,
            strict: true,
            schema: z.toJSONSchema(schema, { target: 'draft-7' }),
          },
        },
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: JSON.stringify(input) },
        ],
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `ИИ недоступен (HTTP ${response.status}). Попробуйте позже.`,
    );
  const raw: unknown = await response.json();
  const envelope = z
    .object({
      choices: z
        .array(
          z.object({
            finish_reason: z.literal('stop'),
            message: z.object({
              content: z.string().max(80_000),
              refusal: z.null().optional(),
              tool_calls: z.null().optional(),
            }),
          }),
        )
        .min(1),
    })
    .parse(raw);
  return schema.parse(JSON.parse(envelope.choices[0].message.content));
}
