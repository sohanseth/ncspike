UPDATE memory_nodes
SET data = data || jsonb_build_object(
  'category', 'proactive',
  'domain', 'professional',
  'reason', 'Job / recruiter thread',
  'classified_by', 'rules'
),
importance = 1
WHERE source LIKE 'gmail:%'
  AND data->>'category' = 'needs_review'
  AND (
    label ~* '\m(application|recruiter|recruiting|hiring)\M'
    OR label ~* '\[external\]'
    OR label ~* '\mR\d{4,}\M'
    OR label ~* '\m(manager|engineer|developer|designer|analyst|scientist|lead|director|architect)\M.*\m(remote|hybrid|onsite)\M'
  );