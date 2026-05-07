-- Family / school / kids
UPDATE memory_nodes
SET data = data || jsonb_build_object(
  'category', 'today',
  'domain', 'family',
  'reason', 'School / kids'' activity',
  'classified_by', 'rules'
),
importance = 2
WHERE source LIKE 'gmail:%'
  AND data->>'category' = 'needs_review'
  AND (
    label ~* '\m(school|teacher|classroom|homework|pta)\M'
    OR label ~* '\m(children''?s?|kids?)\s+(festival|theatre|theater|trip|workshop|camp|club|party)\M'
    OR label ~* '\m(ballet|swimming\s+lesson|piano\s+lesson|judo|karate|gymnastics)\M'
    OR label ~* '\m(pickup|drop[-\s]?off|permission\s+slip|field\s+trip)\M'
    OR label ~* '\mP[1-7]\M'
    OR label ~* '\mYear\s*[1-9]\M'
    OR label ~* '\m(la\s+jolie\s+ronde|stagecoach|rainbows|brownies|cubs|scouts|beavers)\M'
  );

-- Known employers
UPDATE memory_nodes
SET data = data || jsonb_build_object(
  'category', 'proactive',
  'domain', 'professional',
  'reason', 'Known employer mention',
  'classified_by', 'rules'
),
importance = 1
WHERE source LIKE 'gmail:%'
  AND data->>'category' = 'needs_review'
  AND label ~* '\m(nearform|crowdstrike|datadog|cloudflare|vercel|netlify|hashicorp|stripe|shopify|airbnb|uber|meta|amazon|google|microsoft|apple|netflix|spotify|atlassian|gitlab|github|figma|notion|linear|anthropic|openai|deepmind|nvidia|databricks|snowflake|mongodb|elastic|confluent|twilio|segment|braze|intercom|zendesk|salesforce|workday|servicenow|palantir|deloitte|accenture|capgemini|infosys|tcs|wipro|ibm|oracle|sap)\M';