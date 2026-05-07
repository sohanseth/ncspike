// Phase 1 of local-first roadmap: deterministic email triage in the Worker.
// No external network calls. Sender domain + subject keyword based.
// Returns confidence so the caller can decide whether to fall back to an LLM
// or tag the email as `needs_review`.

export type EmailCategory = "urgent" | "today" | "proactive" | "ignore" | "needs_review";
export type EmailDomain = "professional" | "learning" | "social" | "family" | "personal";

export interface RuleResult {
  category: EmailCategory;
  domain: EmailDomain;
  confidence: "high" | "low";
  reason: string;
}

function extractDomain(from: string): string {
  // "Name <user@host.tld>" or "user@host.tld"
  const match = from.match(/<([^>]+)>/);
  const addr = (match ? match[1] : from).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at === -1) return "";
  return addr.slice(at + 1);
}

function domainMatches(host: string, patterns: string[]): boolean {
  return patterns.some((p) => host === p || host.endsWith(`.${p}`));
}

// Sender-domain → (domain, category). High confidence: we trust the sender alone.
const SENDER_RULES: Array<{ hosts: string[]; domain: EmailDomain; category: EmailCategory; reason: string }> = [
  // Job search / ATS
  {
    hosts: ["greenhouse.io", "ashbyhq.com", "lever.co", "workday.com", "myworkdayjobs.com", "smartrecruiters.com", "workable.com", "bamboohr.com", "jobvite.com", "icims.com", "taleo.net", "successfactors.com"],
    domain: "professional",
    category: "proactive",
    reason: "ATS / job application sender",
  },
  {
    hosts: ["linkedin.com", "linkedinmail.com"],
    domain: "professional",
    category: "proactive",
    reason: "LinkedIn",
  },
  // Shopping / receipts / shipping
  {
    hosts: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.in", "amazon.ca", "amazon.fr", "ebay.com", "etsy.com", "shopify.com", "shop.app", "aliexpress.com"],
    domain: "personal",
    category: "ignore",
    reason: "Shopping receipt",
  },
  // Banking / finance / utilities (security alerts may be urgent — handled via subject below)
  {
    hosts: ["stripe.com", "paypal.com", "wise.com", "revolut.com", "monzo.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "hsbc.com", "barclays.com"],
    domain: "personal",
    category: "ignore",
    reason: "Financial / banking",
  },
  // Travel
  {
    hosts: ["booking.com", "airbnb.com", "expedia.com", "kayak.com", "uber.com", "lyft.com", "delta.com", "united.com", "americanairlines.com", "britishairways.com"],
    domain: "personal",
    category: "ignore",
    reason: "Travel booking",
  },
  // Learning
  {
    hosts: ["substack.com", "medium.com", "coursera.org", "edx.org", "udemy.com", "khanacademy.org", "duolingo.com", "arxiv.org", "papers.ssrn.com"],
    domain: "learning",
    category: "proactive",
    reason: "Learning platform",
  },
  // Social
  {
    hosts: ["facebook.com", "facebookmail.com", "instagram.com", "twitter.com", "x.com", "discord.com", "reddit.com", "meetup.com", "eventbrite.com"],
    domain: "social",
    category: "ignore",
    reason: "Social platform",
  },
  // Calendar / scheduling
  {
    hosts: ["calendly.com", "cal.com", "doodle.com", "calendar.google.com"],
    domain: "professional",
    category: "today",
    reason: "Calendar / scheduling",
  },
];

// Subject-keyword nudges. These OVERRIDE sender categorization when matched.
const SUBJECT_RULES: Array<{ patterns: RegExp[]; category?: EmailCategory; domain?: EmailDomain; reason: string }> = [
  {
    patterns: [/\binterview\b/i, /\bphone\s*screen\b/i, /\bonsite\b/i],
    category: "urgent",
    domain: "professional",
    reason: "Interview scheduling",
  },
  {
    patterns: [/\boffer\s+letter\b/i, /\bjob\s+offer\b/i, /\bcongratulations.*offer\b/i],
    category: "urgent",
    domain: "professional",
    reason: "Job offer",
  },
  {
    patterns: [/\bapplication\s+(received|submitted|confirm)/i, /\bthank\s+you\s+for\s+(applying|your\s+application)/i, /\byour\s+application\s+to\b/i],
    category: "proactive",
    domain: "professional",
    reason: "Job application confirmation",
  },
  {
    // Generic job-application chatter: "CrowdStrike Application | Sr. Manager...",
    // "Re: Nearform — Senior Engineer", forwarded recruiter threads, etc.
    patterns: [
      /\bapplication\b.*\b(manager|engineer|developer|designer|analyst|scientist|lead|director|architect|consultant|recruiter)\b/i,
      /\b(manager|engineer|developer|designer|analyst|scientist|lead|director|architect)\b.*\b(remote|hybrid|onsite)\b/i,
      /\b(recruiter|recruiting|talent\s+team|hiring\s+team|sourcer)\b/i,
      /\bR\d{4,}\b/, // requisition IDs like R27239
      /\[external\]/i,
      /\bnext\s+steps\b.*\b(role|position|opportunity|interview)\b/i,
    ],
    category: "proactive",
    domain: "professional",
    reason: "Job / recruiter thread",
  },
  {
    patterns: [/\bsecurity\s+alert\b/i, /\bnew\s+sign-?in\b/i, /\bunusual\s+activity\b/i, /\bpassword\s+(reset|changed)\b/i, /\bverification\s+code\b/i, /\b2fa\b/i],
    category: "urgent",
    domain: "personal",
    reason: "Security alert",
  },
  {
    patterns: [/\bunsubscribe\b/i, /\bnewsletter\b/i, /%\s*off\b/i, /\bsale\s+ends\b/i, /\bblack\s+friday\b/i, /\bcyber\s+monday\b/i],
    category: "ignore",
    reason: "Newsletter / promo",
  },
  {
    patterns: [/\binvoice\b/i, /\breceipt\b/i, /\border\s+(shipped|confirmed|delivered)\b/i],
    category: "ignore",
    domain: "personal",
    reason: "Receipt / shipping",
  },
  {
    // Family / school / kids' activities
    patterns: [
      /\b(school|teacher|classroom|homework|pta|parents?\s+evening|parent[-\s]teacher)\b/i,
      /\b(ballet|swimming\s+lesson|piano\s+lesson|football\s+practice|judo|karate|gymnastics)\b/i,
      /\b(children'?s?|kids?)\s+(festival|theatre|theater|trip|workshop|camp|club|party)\b/i,
      /\b(pickup|drop[-\s]?off|permission\s+slip|field\s+trip)\b/i,
      /\bP[1-7]\b/, // UK primary school year groups (P1..P7)
      /\bYear\s*[1-9]\b/i,
      /\b(la\s+jolie\s+ronde|stagecoach|rainbows|brownies|cubs|scouts|beavers)\b/i, // common UK kids' clubs
    ],
    category: "today",
    domain: "family",
    reason: "School / kids' activity",
  },
  {
    // Forwarded brand-only subjects: "Fwd: Nearform", "Fwd: Stripe", etc.
    // Matches well-known tech/recruiting employers — extend as needed.
    patterns: [
      /\b(nearform|crowdstrike|datadog|cloudflare|vercel|netlify|hashicorp|stripe|shopify|airbnb|uber|meta|amazon|google|microsoft|apple|netflix|spotify|atlassian|gitlab|github|figma|notion|linear|anthropic|openai|deepmind|nvidia|databricks|snowflake|mongodb|elastic|confluent|twilio|segment|braze|intercom|zendesk|salesforce|workday|servicenow|palantir|deloitte|accenture|capgemini|infosys|tcs|wipro|ibm|oracle|sap)\b/i,
    ],
    category: "proactive",
    domain: "professional",
    reason: "Known employer mention",
  },
];

export function rulesClassify(from: string, subject: string): RuleResult {
  const host = extractDomain(from);
  const subj = subject || "";

  // 1) Sender lookup
  let base: RuleResult | null = null;
  for (const rule of SENDER_RULES) {
    if (domainMatches(host, rule.hosts)) {
      base = {
        category: rule.category,
        domain: rule.domain,
        confidence: "high",
        reason: rule.reason,
      };
      break;
    }
  }

  // 2) Subject overrides (can upgrade urgency or recategorize)
  for (const rule of SUBJECT_RULES) {
    if (rule.patterns.some((p) => p.test(subj))) {
      return {
        category: rule.category ?? base?.category ?? "needs_review",
        domain: rule.domain ?? base?.domain ?? "personal",
        confidence: "high",
        reason: rule.reason,
      };
    }
  }

  if (base) return base;

  // 3) Unknown → low confidence, needs review
  return {
    category: "needs_review",
    domain: "personal",
    confidence: "low",
    reason: "No matching rule",
  };
}
