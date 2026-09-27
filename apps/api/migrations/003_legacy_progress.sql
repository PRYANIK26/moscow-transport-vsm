-- Retry only legacy fractional result events that failed before integer normalization existed.
-- Immutable results and already applied projections are not changed.
UPDATE outbox AS event
SET attempts = 0, failed_at = NULL, last_error = NULL, next_at = now()
WHERE event.module = 'progress'
  AND event.kind = 'result'
  AND event.processed_at IS NULL
  AND event.failed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM progress_applied AS applied
    WHERE applied.result_id::text = (event.payload->'detail'->>'id')
  )
  AND EXISTS (
    SELECT 1
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(event.payload->'detail'->'competencies') = 'object'
        THEN event.payload->'detail'->'competencies' ELSE '{}'::jsonb END
    ) AS competency(key, value)
    WHERE CASE WHEN jsonb_typeof(competency.value) = 'number'
      THEN (competency.value::text)::numeric % 1 <> 0 ELSE false END
  );
