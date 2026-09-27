-- Fixed duration: 30 x 24 hours from completion, independent of session timezone and DST.
CREATE INDEX IF NOT EXISTS results_completed_at_idx ON results(completed_at);

-- Existing ledger rows are projections, not immutable results. Keep them consistent with the new policy.
UPDATE rating_ledger AS ledger
SET expires_at = result.completed_at + interval '720 hours'
FROM results AS result
WHERE result.id = ledger.result_id
  AND ledger.expires_at IS DISTINCT FROM result.completed_at + interval '720 hours';
