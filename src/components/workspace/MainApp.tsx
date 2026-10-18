import { useState, useRef, useEffect, useMemo, useCallback, lazy, Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth-context";
import { webSearch, logOpenedSearchUrl } from "@/lib/search.functions";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen, Heart, MessageCircle, Briefcase, ShoppingBag,
  Brain, TrendingUp, Zap, ArrowRight, Check,
  Send, X, ChevronDown, PenLine, Shield,
  Layers, RefreshCw, ChevronRight, Sparkles,
  Moon, Clock, Loader, Lock, ExternalLink, Star, ShoppingCart,
  Search, Mic, MicOff, Lightbulb, Volume2,
  Flag, RotateCcw, Bell, BellRing, User, Plus, ChevronUp, CalendarDays, Calendar, Package, Plug, LogOut, Mail, Inbox, ArrowLeft, Pin, PinOff, Paperclip, ListTodo,
  ShieldAlert, Camera as CameraIcon, MoreHorizontal,
} from "lucide-react";
import { IMAGE_BLOCKED_PLACEHOLDER_TEXT } from "@/lib/chat-message-kinds";
import { IMAGE_BLOCKED_RETRY_ACTION_LABEL } from "@/lib/chat-message-kinds";
import {
  makePending,
  revokePending,
  uploadAttachments,
  validateImage,
  MAX_FILES_PER_MESSAGE,
  type PendingAttachment,
} from "@/lib/chat-attachments";
import { BriefingsButton } from "@/components/workspace/BriefingsButton";
import { ContextFooter } from "@/components/workspace/ContextFooter";
import type { SendVoiceMessage } from "@/components/workspace/ConverseInput";
// Lazy-loaded so the entire voice surface (resolver, StatusPill, SpeakingOrb)
// is code-split out of the main bundle until the user opens Chat.
const ConverseInput = lazy(() =>
  import("@/components/workspace/ConverseInput").then((m) => ({ default: m.ConverseInput })),
);
import { StatusPill } from "@/components/workspace/StatusPill";
import { buildTriple } from "@/lib/voice-resolver";
import { readPreferLocalAudio } from "@/lib/voice-preferences";
import { supabase } from "@/integrations/supabase/client";
import type { Badge as VoiceBadge } from "@/lib/voice-types";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useManualTasks, classifyTask, type ManualTask } from "@/lib/manual-tasks";
import { useCloudConsent } from "@/components/workspace/CloudFeatureSheet";
import { CLOUD_FEATURE_OFF_MESSAGE } from "@/lib/cloud-features";

// Default ElevenLabs voice for the unified Converse surface (matches the
// server-side default in tts/elevenlabs-flash.ts: George — neutral low-latency).
const DEFAULT_TTS_VOICE = "JBFqnCBsd6RMkjVDRZzb";

/** Play assistant text via the proxied ElevenLabs endpoint. PRIVATE badge skips. */
/** Read text with the device's own voice (never a network voice). */
export function speakOnDevice(text: string): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  const voices = window.speechSynthesis.getVoices();
  const local = voices.find((v) => v.localService && v.lang.startsWith(navigator.language.slice(0, 2)))
    ?? voices.find((v) => v.localService);
  if (!local) return false;
  const u = new SpeechSynthesisUtterance(text.slice(0, 5000));
  u.voice = local;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return true;
}

async function playAssistantTts(
  text: string,
  badge: VoiceBadge,
  cloudVoice = true,
): Promise<HTMLAudioElement | null> {
  if (badge === "PRIVATE" || !text.trim()) return null;
  if (!cloudVoice) {
    speakOnDevice(text);
    return null;
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const res = await fetch("/api/tts/elevenlabs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: text.slice(0, 5000), voiceId: DEFAULT_TTS_VOICE }),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  void audio.play().catch(() => URL.revokeObjectURL(url));
  return audio;
}

const AI_MODEL_TO_BADGE: Record<AIModel, VoiceBadge> = {
  flash: "FLASH",
  pro: "PRO",
  genius: "Genius",
  private: "PRIVATE",
};


// ─── Types ────────────────────────────────────────────────────────────────────

type DomainId = "learning" | "family" | "social" | "professional" | "personal";
type MapView   = "mindmap" | "memory" | "signals" | "tasks";
type TaskStatus  = "queued" | "running" | "done";
type VoiceMode   = "quick" | "deep";
type Tool      = "chat" | "compose" | null;
type MemoryCategory = "People" | "Projects" | "Preferences" | "Deadlines" | "Writing style" | "Recurring";
type Confidence = "high" | "medium" | "low";
type ComposeChannel = "Email" | "Slack" | "WhatsApp" | "Doc" | "LinkedIn";
type ComposeTone    = "Professional" | "Warm" | "Concise" | "Persuasive" | "Casual";
type AIModel        = "flash" | "pro" | "genius" | "private";

interface DomainItem { id: number; text: string; meta: string; urgent: boolean; progress: number; }
interface DomainData {
  id: DomainId; label: string; Icon: LucideIcon;
  activity: number; sources: string[]; weekLabel: string;
  connectionNote: string; items: DomainItem[];
}
interface MindNode { id: string; domainId: DomainId; label: string; sub: string; x: number; y: number; }
interface MindEdge { from: string; to: string; cross: boolean; }
interface MemoryItem {
  id: string; category: MemoryCategory; belief: string;
  source: string; lastUsed: string; confidence: Confidence; inferred: boolean;
}
interface AgentResult {
  summary: string;
  items: { name: string; price: string; source: string; match: number; note: string; link?: string }[];
}
interface AgentTask {
  id: string; title: string; input: string; status: TaskStatus;
  domain: DomainId; createdAt: string; completedAt?: string; duration?: string;
  agentSteps?: string[]; result?: AgentResult;
}
interface ProactiveSuggestion {
  id: string; title: string; body: string;
  reasoning: { domain: DomainId; source: string; fact: string }[];
  action: string; actionType: "overnight" | "compose" | "remind";
  domain: DomainId; urgency: "high" | "medium" | "low";
}
type ActionType = "urgent" | "today" | "overdue" | "proactive";
interface ActionItem {
  id: string; type: ActionType; domain: DomainId;
  text: string; meta: string;
  actionLabel: string; actionKind: "compose" | "check" | "overnight" | "domain";
}
interface Signal {
  id: string; title: string; momentum: "rising" | "stable" | "fading";
  evidenceCount: number; domains: DomainId[]; suggestedAction: string; summary: string;
}

// ─── Domain colors ────────────────────────────────────────────────────────────

const C = Object.fromEntries(
  (["learning", "professional", "social", "family", "personal"] as const).map(id => [id, {
    text: `text-${id}`, border: `border-${id}/20`, dot: `bg-${id}/60`, bar: `bg-${id}`,
    hex: `var(--${id})`, light: `var(--${id})`,
    glow: `color-mix(in oklch, var(--${id}) 12%, transparent)`,
    tile: `var(--${id}-surface)`, icon: `var(--${id})`,
  }]),
) as Record<DomainId, { text: string; border: string; dot: string; bar: string; hex: string; light: string; glow: string; tile: string; icon: string }>;

// ─── Data ─────────────────────────────────────────────────────────────────────

const DOMAINS: Record<DomainId, DomainData> = {
  learning:     { id:"learning",     label:"Learning",     Icon:BookOpen,      activity:0.92, sources:["Coursera","Kindle","Chrome"],       weekLabel:"AI-heavy",  connectionNote:"AI learning generating LinkedIn draft posts", items:[
    { id:1, text:"AI Agents Crash Course",          meta:"65% · 3 lessons left",           urgent:false, progress:0.65 },
    { id:2, text:"Prompt Engineering for Devs",     meta:"Not started · added yesterday",  urgent:false, progress:0    },
    { id:3, text:"The Alignment Problem",           meta:"Book · Ch. 4 · p.147",           urgent:false, progress:0.4  },
    { id:4, text:"AI Safety Fundamentals",          meta:"Saved · 4h estimated",           urgent:false, progress:0    },
  ]},
  professional: { id:"professional", label:"Professional", Icon:Briefcase,     activity:0.72, sources:["LinkedIn","Gmail","Calendar"],      weekLabel:"Growing",   connectionNote:"AI learning generating post content", items:[
    { id:1, text:"Reply to Sarah — partnership terms", meta:"Gmail · today is last chance",urgent:true,  progress:0    },
    { id:2, text:"Draft: AI agents post",           meta:"Ready to publish",               urgent:false, progress:0.9  },
    { id:3, text:"Networking event · May 12",       meta:"RSVP pending",                   urgent:true,  progress:0    },
    { id:4, text:"Client email rewrite",            meta:"Polish needed",                  urgent:false, progress:0    },
  ]},
  social:       { id:"social",       label:"Social",       Icon:MessageCircle, activity:0.62, sources:["WhatsApp","Instagram","iMessage"],  weekLabel:"3 pending", connectionNote:"School parents group bridges Social + Family", items:[
    { id:1, text:"Reply to Maya · coffee",          meta:"3 days overdue · WhatsApp",      urgent:true,  progress:0    },
    { id:2, text:"Jake — weekend plans",            meta:"Yesterday",                      urgent:false, progress:0    },
    { id:3, text:"School Parents Group",            meta:"4 unread · activity sign-up",    urgent:true,  progress:0    },
    { id:4, text:"@alex_creates DM",                meta:"Instagram · 3 days",             urgent:false, progress:0    },
  ]},
  family:       { id:"family",       label:"Family",       Icon:Heart,         activity:0.55, sources:["Calendar","WhatsApp","School App"], weekLabel:"2 urgent",  connectionNote:"", items:[
    { id:1, text:"Zara's ballet class",             meta:"Today · 4:00 PM · pickup",       urgent:true,  progress:0    },
    { id:2, text:"Art project supplies",            meta:"Due Friday · paint + canvas",    urgent:true,  progress:0    },
    { id:3, text:"Grocery delivery",                meta:"7 items · Friday AM",            urgent:false, progress:0    },
    { id:4, text:"Parent-teacher meeting",          meta:"May 14 · confirmation pending",  urgent:false, progress:0    },
  ]},
  personal:     { id:"personal",     label:"Personal",     Icon:ShoppingBag,   activity:0.28, sources:["Chrome","ASOS","Instagram"],       weekLabel:"Low",       connectionNote:"", items:[
    { id:1, text:"Running shoes",                   meta:"8 searches · Nike leading",      urgent:false, progress:0    },
    { id:2, text:"Paris trip",                      meta:"Late June · 2 hotels bookmarked",urgent:false, progress:0.3  },
    { id:3, text:"Summer wardrobe",                 meta:"Zara + ASOS shortlisted",        urgent:false, progress:0    },
  ]},
};

const MIND_NODES: MindNode[] = [
  { id:"l1", domainId:"learning",     label:"AI Agents Course",    sub:"65% · in progress",      x:28, y:18 },
  { id:"l2", domainId:"learning",     label:"Prompt Engineering",  sub:"Not started",             x:48, y:10 },
  { id:"l3", domainId:"learning",     label:"Alignment Problem",   sub:"Book · Ch. 4",            x:18, y:30 },
  { id:"p1", domainId:"professional", label:"LinkedIn post",       sub:"Ready to publish",        x:72, y:15 },
  { id:"p2", domainId:"professional", label:"Networking · May 12", sub:"RSVP due",                x:84, y:28 },
  { id:"p3", domainId:"professional", label:"Client email",        sub:"Rewrite needed",          x:78, y:42 },
  { id:"s1", domainId:"social",       label:"Maya",                sub:"Coffee · 3d pending",     x:80, y:62 },
  { id:"s2", domainId:"social",       label:"Jake",                sub:"Weekend plans",           x:90, y:74 },
  { id:"s3", domainId:"social",       label:"School Parents",      sub:"4 unread",                x:68, y:78 },
  { id:"f1", domainId:"family",       label:"Ballet class",        sub:"Today 4pm",               x:42, y:82 },
  { id:"f2", domainId:"family",       label:"Art supplies",        sub:"Due Friday",              x:28, y:76 },
  { id:"f3", domainId:"family",       label:"Groceries",           sub:"7 items · Friday",        x:18, y:64 },
  { id:"r1", domainId:"personal",     label:"Running shoes",       sub:"8 searches",              x:14, y:46 },
  { id:"r2", domainId:"personal",     label:"Paris trip",          sub:"Late June",               x:10, y:56 },
  { id:"sig",domainId:"professional", label:"Data sovereignty",    sub:"15 signals · rising",     x:50, y:48 },
];
const MIND_EDGES: MindEdge[] = [
  { from:"l1", to:"l2",  cross:false },{ from:"l1", to:"l3",  cross:false },
  { from:"l1", to:"p1",  cross:true  },{ from:"l1", to:"sig", cross:true  },
  { from:"p1", to:"p2",  cross:false },{ from:"p3", to:"sig", cross:true  },
  { from:"s1", to:"s2",  cross:false },{ from:"s3", to:"f1",  cross:true  },
  { from:"s3", to:"f2",  cross:true  },{ from:"f1", to:"f2",  cross:false },
  { from:"f2", to:"f3",  cross:false },{ from:"sig", to:"p1", cross:true  },
];

const MEMORY_ITEMS: MemoryItem[] = [
  { id:"m1", category:"People",       belief:"Sarah Chen is a partner lead at a16z, focused on early-stage B2B SaaS",          source:"Gmail · Partnership thread",      lastUsed:"2h ago",    confidence:"high",   inferred:false },
  { id:"m2", category:"People",       belief:"Priya is your engineering co-lead — expects weekly syncs on Q2",                  source:"Calendar · recurring meetings",   lastUsed:"Today",     confidence:"high",   inferred:false },
  { id:"m3", category:"People",       belief:"Maya is a close friend — prefers WhatsApp, usually free Thursdays",               source:"WhatsApp · message history",      lastUsed:"Yesterday", confidence:"medium", inferred:true  },
  { id:"m4", category:"Projects",     belief:"Q2 roadmap focus: mid-market expansion, Memory trust layer, Signals v1",          source:"Notion · Q2 Roadmap doc",         lastUsed:"2h ago",    confidence:"high",   inferred:false },
  { id:"m5", category:"Projects",     belief:"Partnership with Sarah is in final negotiation — response due today",             source:"Gmail · Partnership thread",      lastUsed:"Today",     confidence:"high",   inferred:false },
  { id:"m6", category:"Preferences",  belief:"Professional emails: short paragraphs, direct, no bullets externally",            source:"Gmail · sent folder · 45 samples",lastUsed:"2h ago",    confidence:"high",   inferred:true  },
  { id:"m7", category:"Deadlines",    belief:"Q2 roadmap must be shared with Priya + Theo before Wednesday May 8",             source:"Calendar · Priya message",        lastUsed:"Today",     confidence:"high",   inferred:false },
  { id:"m8", category:"Deadlines",    belief:"Sarah partnership response needed today — she flagged May 6 as last chance",      source:"Gmail · Sarah · May 4",           lastUsed:"Today",     confidence:"high",   inferred:false },
  { id:"m9", category:"Writing style",belief:"Sign-off: 'Best,' for professional; 'Talk soon' or emoji for friends",           source:"Gmail + WhatsApp · sent folder",  lastUsed:"2h ago",    confidence:"high",   inferred:true  },
  { id:"m10",category:"Recurring",    belief:"Tuesday 10am: Q2 sync with Priya and Theo — standing meeting",                   source:"Google Calendar · recurring",     lastUsed:"Today",     confidence:"high",   inferred:false },
  { id:"m11",category:"Recurring",    belief:"Zara has ballet class Tue + Thu at 4pm — pickup required every time",            source:"School app + Calendar",           lastUsed:"Today",     confidence:"high",   inferred:false },
];

const SIGNALS: Signal[] = [
  { id:"s1", title:"Data sovereignty as product thesis", momentum:"rising",  evidenceCount:15, domains:["learning","professional","social"],  suggestedAction:"Save as Project",    summary:"Referenced across AI Agents notes, LinkedIn draft, and 3 prospect conversations. Growing week-on-week." },
  { id:"s2", title:"Partnership velocity accelerating",  momentum:"rising",  evidenceCount:9,  domains:["professional"],                      suggestedAction:"Pin to Q2 Roadmap",  summary:"Sarah terms + networking event + two inbound LinkedIn requests cluster around this week." },
  { id:"s3", title:"Zara school commitments dense",      momentum:"stable",  evidenceCount:6,  domains:["family","social"],                   suggestedAction:"Add recurring block", summary:"Art project, ballet, parents meeting all this week — pattern repeated monthly for 3 months." },
  { id:"s4", title:"AI content output rising",           momentum:"rising",  evidenceCount:11, domains:["learning","professional"],            suggestedAction:"Schedule cadence",   summary:"3 drafts ready, Coursera at 65%, 2 LinkedIn connections from AI field. Content flywheel forming." },
];

const AGENT_TASKS: AgentTask[] = [
  {
    id:"a1", title:"Find a dress for Maya's wedding", domain:"personal", status:"done",
    input:"Looking for a dress for Maya's wedding, mid-June, budget £200, not too formal. Maya's style is elegant-casual.",
    createdAt:"Last night · 11:42 PM", completedAt:"6:18 AM", duration:"6h 36m",
    agentSteps:["Read style preferences from Memory (45 past purchases)","Searched Net-a-Porter, ASOS, Reiss, & Other Stories","Filtered by budget £200, midi+ length, June weather","Ranked against your colour history (navy, sage, terracotta)","Cross-checked Maya's Instagram for venue/dress code cues"],
    result:{
      summary:"Found 5 options within budget that match your style profile. Top pick is a strong 95% match — midi length, sage green, available in your size. Two backup options at different price points included.",
      items:[
        { name:"Reformation Midi — Sage", price:"£178", source:"Net-a-Porter", match:95, note:"Midi length, your preferred silhouette. Sage matches 3 recent purchases. Ships in time for June." },
        { name:"& Other Stories Wrap Dress", price:"£145", source:"& Other Stories", match:88, note:"Wrap style suits your body preference noted in Memory. Navy colourway available." },
        { name:"Reiss Hailey Slip Dress", price:"£195", source:"Reiss", match:82, note:"Slightly more formal — good if venue turns out dressier. Free returns." },
        { name:"ASOS Edition Midi", price:"£89", source:"ASOS", match:79, note:"Best price. Terracotta. Reviews flag sizing runs small — order up." },
        { name:"Sézane Florentine Dress", price:"£185", source:"Sézane", match:76, note:"French label you favourited in March. Out of your usual palette but strong reviews for weddings." },
      ],
    },
  },
  {
    id:"a2", title:"Research Paris hotels for late June", domain:"personal", status:"running",
    input:"Find hotels in Paris for late June, 5 nights, budget around £1,200 total. Near Marais or Saint-Germain. No chains if possible.",
    createdAt:"Tonight · 12:05 AM",
    agentSteps:["Checking availability on Booking.com, Mr & Mrs Smith, Hip Hotels","Filtering: boutique, Marais/Saint-Germain, late June availability","Comparing guest reviews for solo female traveller context","Cross-referencing with your saved Paris notes in Notion"],
  },
  {
    id:"a3", title:"Find the right running shoes", domain:"personal", status:"queued",
    input:"I need running shoes. I pronate slightly, train 3x per week, mostly road running. Budget £130. Something that doesn't look too technical.",
    createdAt:"Queued · 2 min ago",
  },
  {
    id:"a4", title:"Draft AI agents LinkedIn post", domain:"professional", status:"done",
    input:"Write a LinkedIn post about what I've learned from the AI Agents crash course. Focus on the data sovereignty angle. My tone: direct, no hype, practical examples.",
    createdAt:"2 nights ago · 11:58 PM", completedAt:"5:47 AM", duration:"5h 49m",
    agentSteps:["Read your AI Agents course notes (65% complete)","Pulled your past LinkedIn post performance from Memory","Analysed top-performing posts in AI/founder category this month","Drafted 3 variants — different hooks, same substance"],
    result:{
      summary:"3 post drafts ready. Variant A performed best in similar accounts this month — direct hook, no throat-clearing. Variant B is softer for a wider audience. Variant C is the shortest.",
      items:[
        { name:"Variant A — Direct hook", price:"~1,100 chars", source:"LinkedIn draft", match:91, note:"Opens with a contrarian claim about AI agents. Matches your voice profile from 45 past posts." },
        { name:"Variant B — Narrative", price:"~1,400 chars", source:"LinkedIn draft", match:83, note:"Starts with the problem Sarah Chen raised — good for broader reach." },
        { name:"Variant C — Short form", price:"~600 chars", source:"LinkedIn draft", match:76, note:"For high-engagement slot (Tue 8am). Punchy, one idea only." },
      ],
    },
  },
];

const SUGGESTED_TASKS = [
  { icon:ShoppingCart, text:"Find a dress for Maya's wedding, budget £200" },
  { icon:Search,       text:"Research the best AI productivity tools for founders" },
  { icon:Star,         text:"Plan a weekend itinerary for Paris in late June" },
  { icon:Brain,        text:"Summarise what I've learned about AI agents this week" },
];

const PROACTIVE_SUGGESTIONS: ProactiveSuggestion[] = [
  {
    id:"p1", domain:"personal", urgency:"high",
    title:"Maya's wedding is 6 weeks away — no dress found yet",
    body:"You have a wedding on June 15 and your summer wardrobe task has been open for 3 weeks with no purchase. I can research options tonight while you sleep.",
    reasoning:[
      { domain:"social",   source:"Calendar",  fact:"Maya's wedding · June 15 · 6 weeks away" },
      { domain:"personal", source:"NC Memory", fact:"Summer wardrobe task open 3 weeks · no purchase" },
      { domain:"personal", source:"Gmail",     fact:"No order confirmations for occasion wear" },
    ],
    action:"Find a dress overnight", actionType:"overnight",
  },
  {
    id:"p2", domain:"professional", urgency:"medium",
    title:"3 signals suggest you should post about AI agents this week",
    body:"Your course is at 65%, the data sovereignty thesis is rising across 15 signals, and the networking event is May 12. A post this week hits the right moment.",
    reasoning:[
      { domain:"learning",     source:"Coursera",  fact:"AI Agents 65% complete · momentum high" },
      { domain:"professional", source:"Signals",   fact:"Data sovereignty thesis · 15 signals · rising" },
      { domain:"professional", source:"Calendar",  fact:"Networking event May 12 · 6 days away" },
    ],
    action:"Draft LinkedIn post now", actionType:"compose",
  },
  {
    id:"p3", domain:"personal", urgency:"low",
    title:"Paris trip + running shoes — I can solve both in one search",
    body:"You're researching running shoes and planning Paris in late June. I can find shoes that work for city walking and running routes near your likely hotel area.",
    reasoning:[
      { domain:"personal", source:"NC Memory", fact:"Running shoes · 8 searches · no decision" },
      { domain:"personal", source:"NC Memory", fact:"Paris trip · late June · hotels shortlisted" },
      { domain:"learning", source:"Signals",   fact:"Active lifestyle pattern emerging this month" },
    ],
    action:"Research both overnight", actionType:"overnight",
  },
];

const VOICE_DEMOS: { mode: VoiceMode; transcript: string; quickResponse?: string }[] = [
  {
    mode:"quick",
    transcript:"What do I need to do before the Sarah Chen meeting today?",
    quickResponse:"Reply to Sarah's email before 5pm — she flagged today as the last chance on partnership terms. The key open point is the data access clause in section 4. Your draft is 90% ready in Compose.",
  },
  {
    mode:"deep",
    transcript:"Find me running shoes that work for Paris trip in June",
    quickResponse:undefined,
  },
];

const ACTION_QUEUE: ActionItem[] = [
  { id:"aq1", type:"urgent",    domain:"professional", text:"Reply to Sarah — partnership terms",   meta:"Today is the last chance · a16z",         actionLabel:"Compose reply", actionKind:"compose"  },
  { id:"aq2", type:"today",     domain:"family",       text:"Pick up Zara · Ballet · 4:00 PM",      meta:"Today · starts in 2h 15m",                actionLabel:"Mark done",     actionKind:"check"    },
  { id:"aq3", type:"overdue",   domain:"social",       text:"Reply to Maya · coffee catch-up",      meta:"3 days overdue · WhatsApp",               actionLabel:"Compose reply", actionKind:"compose"  },
  { id:"aq4", type:"proactive", domain:"personal",     text:"Maya's wedding in 6 weeks — no dress", meta:"NC connected 3 signals · research ready",  actionLabel:"Run tonight",   actionKind:"overnight" },
];
const ACTION_QUEUE_OVERFLOW = 3; // additional urgent items not shown

const CAT_DOT: Record<MemoryCategory,string> = {
  "People":"bg-sky-400","Projects":"bg-violet-400","Preferences":"bg-emerald-400",
  "Deadlines":"bg-red-400","Writing style":"bg-amber-400","Recurring":"bg-teal-400",
};
const CONF: Record<Confidence,string> = {
  high:"text-personal border-emerald-500/25 bg-emerald-500/10",
  medium:"text-family border-amber-500/25 bg-amber-500/10",
  low:"text-red-300 border-red-500/25 bg-red-500/10",
};
const DOMAIN_ORDER: DomainId[] = ["learning","professional","social","family","personal"];

// ─── Primitives ───────────────────────────────────────────────────────────────

function Mono({ children, className="" }: { children: React.ReactNode; className?: string }) {
  return <span className={`font-mono text-[10px] tracking-widest uppercase text-muted-foreground ${className}`}>{children}</span>;
}
function Ring({ progress, color }: { progress: number; color: string }) {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 flex-shrink-0 -rotate-90">
      <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="3"/>
      <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="3"
        strokeDasharray={`${progress*56.5} 56.5`} strokeLinecap="round"/>
    </svg>
  );
}

// ─── Domain icon tiles (replaces week pulse) ──────────────────────────────────

function DomainTiles({ onDomain }: { onDomain:(id:DomainId)=>void }) {
  return (
    <div className="flex items-center gap-2">
      {DOMAIN_ORDER.map(id => {
        const d = DOMAINS[id]; const c = C[id]; const Icon = d.Icon;
        const urgentCount = d.items.filter(i=>i.urgent).length;
        return (
          <button key={id} onClick={()=>onDomain(id)}
            className="group relative flex flex-col items-center gap-1 p-0.5"
            title={d.label}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center transition-all group-hover:scale-105 group-hover:brightness-110"
              style={{background:`linear-gradient(135deg, ${c.tile}, ${c.tile})`,boxShadow:`0 2px 12px ${c.glow}`}}>
              <Icon size={16} style={{color:c.icon}}/>
              {urgentCount>0 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-red-500 border border-background flex items-center justify-center text-[7px] font-bold text-destructive-foreground">{urgentCount}</span>
              )}
            </div>
            <span className="text-[8.5px] font-mono text-muted-foreground tracking-wide hidden sm:block">{d.label.slice(0,4).toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Action pill (header buttons: Search / Add tasks / Chat / Compose / You) ─
//
// Glassmorphic pill with a per-button accent colour applied to the icon and
// glow halo. Active state lights the whole pill with the accent. Designed so
// the row of header actions feels like a connected set rather than five
// neutral grey buttons.

function ActionPill({
  icon, label, accent, active, onClick, title,
}: {
  icon: React.ReactNode;
  label: string;
  accent: string;
  active?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <Button variant="outline"
      onClick={onClick} title={title ?? label} aria-label={title ?? label}
      className={`group h-9 gap-2 rounded-lg px-3.5 text-xs shadow-none ${active ? "bg-primary/30 border-success/35 text-foreground" : "bg-card border-border text-foreground/80 hover:bg-secondary"}`}
    >
      <span className="inline-flex items-center justify-center" style={{color:accent}}>{icon}</span>
      <span className="hidden sm:block">{label}</span>
    </Button>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────


function TopBar({
  mapView, setMapView, tool, setTool, onDomain, onVoice, onExplore, onTest,
}: {
  mapView: MapView|null; setMapView:(v:MapView|null)=>void;
  tool: Tool; setTool:(t:Tool)=>void;
  onDomain:(id:DomainId)=>void; onVoice:()=>void; onExplore:()=>void; onTest:()=>void;
}) {
  const pendingTasks = ACTION_QUEUE.filter(a=>a.type==="proactive").length;
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const handleSignOut = async () => { await signOut(); navigate({ to: "/auth" }); };

  return (
    // Header is wrapped in a sticky container in MainApp's render
    // (around line 3967) which handles the pinning + safe-area-inset and
    // backdrop blur. Don't add `sticky top-0` here — duplicating it broke
    // sticky on the wrapper because of nested-positioning interactions.
    <header className="h-14 flex items-center px-4 gap-3 border-b border-border flex-shrink-0 relative z-30">
      {/* Logo */}
      <button onClick={()=>{ setMapView(null); setTool(null); }} className="flex items-center gap-2 hover:opacity-80 transition-opacity flex-shrink-0">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))",boxShadow:"0 0 14px rgba(139,92,246,0.3)"}}>
          <Zap size={13} style={{color:"var(--foreground)"}}/>
        </div>
        <span className="text-[13px] font-semibold tracking-tight text-foreground/80 hidden xl:block" style={{fontFamily:"var(--font-display)"}}>NeuralConnexions</span>
      </button>

      {/* Domain tiles moved out of the header — they now live under the
          greeting on the home canvas, where they have room to breathe. */}

      {/* Primary actions row.
          Mobile (< md): HIDDEN. Mobile gets a Brief + bottom action bar
          (MobileQuickBar below) to reduce information overload — 14 pills
          crammed into a phone is the noise we're trying to drop.
          md+: row scrolls horizontally; min-w-0 stops the container from
          forcing the header wider than the viewport.
          lg+: reverts to right-aligned, no scroll needed. */}
      <div className="hidden md:flex flex-1 min-w-0 lg:flex-initial lg:ml-auto items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Search — opens Google in a new tab */}
        <ActionPill
          icon={<Search size={14}/>}
          label="Search"
          accent="var(--professional)"
          title="Search Google"
          onClick={() => {
            const q = window.prompt("Search Google for:")?.trim();
            if (!q) return;
            const a = document.createElement("a");
            a.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
            a.target = "_blank"; a.rel = "noopener noreferrer";
            document.body.appendChild(a); a.click(); a.remove();
          }}
        />

        {/* Add task — manual entry, auto-categorised into a bento box */}
        <AddTaskButton/>

        {/* Chat / Voice — both icons shown so it's obvious the panel handles
            text and voice. The panel itself has a text/voice toggle. */}
        <ActionPill
          icon={
            <span className="inline-flex items-center gap-1">
              <MessageCircle size={13}/>
              <span className="opacity-40 text-[10px] leading-none">/</span>
              <Mic size={12}/>
            </span>
          }
          label="Chat"
          accent="var(--learning)"
          active={tool==="chat"}
          title="Chat or talk"
          onClick={()=>setTool(tool==="chat"?null:"chat")}
        />

        {/* Compose */}
        <ActionPill
          icon={<PenLine size={14}/>}
          label="Compose"
          accent="var(--social)"
          active={tool==="compose"}
          onClick={()=>setTool(tool==="compose"?null:"compose")}
        />

        <div className="w-px h-5 bg-border mx-1"/>

        {/* You */}
        <ActionPill
          icon={<User size={14}/>}
          label="You"
          accent="var(--personal)"
          active={["mindmap","memory","signals"].includes(mapView??"")}
          onClick={onExplore}
        />

        {/* Briefings — overnight research queue */}
        <BriefingsButton/>

        {/* Connections */}
        <Link to="/workspace/connections"
         
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border border-border text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted transition-all flex-shrink-0"
          style={{fontFamily:"var(--font-sans)"}}
          title="Connect Gmail & Calendar">
          <Plug size={13}/>
          <span className="hidden sm:block">Connect</span>
        </Link>

        {/* Test */}
        <button onClick={onTest}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border border-amber-500/30 bg-amber-500/10 text-family hover:bg-amber-500/20 transition-all flex-shrink-0"
          style={{fontFamily:"var(--font-sans)"}}
          title="Test Scout & OAuth">
          <Sparkles size={13}/>
          <span className="hidden sm:block">Test</span>
        </button>

        <div className="w-px h-5 bg-border mx-1"/>

        {/* Personalization (Phase 2.7 D8 — settings entry for the trait broker) */}
        <Link to="/workspace/personalization" title="Personalization settings"
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-medium border border-border text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted transition-all flex-shrink-0"
          style={{fontFamily:"var(--font-sans)"}}>
          <Shield size={13}/>
          <span className="hidden sm:block">Personalization</span>
        </Link>

        {/* Avatar */}
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
          style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))",color:"#ede9fe"}}>S</div>

        {/* Sign out */}
        <button onClick={handleSignOut} title="Sign out" aria-label="Sign out"
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-medium border border-border text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted transition-all flex-shrink-0"
          style={{fontFamily:"var(--font-sans)"}}>
          <LogOut size={13}/>
          <span className="hidden sm:block">Sign out</span>
        </button>
      </div>
    </header>
  );
}

// ─── Mobile quick bar ─────────────────────────────────────────────────────────
//
// A focused, always-visible entry point pinned to the bottom of the viewport on
// mobile. Matches the "Brief + bottom input" pattern that reduces information
// overload — one place to type whatever you want, plus a voice shortcut.
// Hidden on md+ where the top action rail covers the same intents.
//
// Bottom safe-area padding (pb-[max(...)]) so the bar clears the iPhone home
// indicator without leaving a gap on Androids without the inset.

function MobileQuickBar({ onChat, onCompose, onYou, onTest, onSignOut }: {
  onChat: () => void;
  onCompose: () => void;
  onYou: () => void;
  onTest: () => void;
  onSignOut: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  // Same Google prompt the desktop header's Search pill runs.
  const onSearch = () => {
    const q = window.prompt("Search Google for:")?.trim();
    if (!q) return;
    const a = document.createElement("a");
    a.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    a.target = "_blank"; a.rel = "noopener noreferrer";
    document.body.appendChild(a); a.click(); a.remove();
  };

  const close = () => setMoreOpen(false);
  const act = (fn: () => void) => () => { close(); fn(); };

  return (
    <>
      <div
        className="md:hidden fixed inset-x-0 bottom-0 z-40 bg-background/95 backdrop-blur-md border-t border-border pt-2 px-3"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
      >
        <div className="flex items-center gap-2">
          {/* Single primary entry point. The other intents (Search / Add Task /
              Draft) live as chips inside the ChatPanel empty state — surfacing
              them on home would compete with the Brief + ambient bento for
              attention. Two-tap path is acceptable for those non-primary actions. */}
          <button
            type="button"
            onClick={onChat}
            aria-label="Open chat"
            className="flex-1 flex items-center gap-2.5 px-4 py-3.5 rounded-2xl border border-primary/40 bg-primary/[0.07] text-left text-[14px] text-foreground/90 active:bg-primary/[0.13] transition-colors"
          >
            <Sparkles size={16} className="text-success flex-shrink-0" />
            <span className="flex-1 truncate">Ask anything…</span>
            <Send size={15} className="text-success flex-shrink-0" />
          </button>
          {/* More — the header actions that don't fit on a phone. */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More actions"
            className="flex-shrink-0 flex items-center justify-center w-12 h-12 rounded-2xl border border-border bg-card text-foreground/80 active:bg-secondary transition-colors"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      </div>

      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-label="More actions">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute inset-0 bg-foreground/30 backdrop-blur-sm"
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-3xl glass-elevated p-4 pt-3"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
            <div className="grid grid-cols-1 gap-1">
              <button type="button" onClick={act(onSearch)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <Search size={16} style={{ color: "var(--professional)" }} /> Search
              </button>
              <div className="flex items-center gap-3 rounded-xl px-3 py-1 [&>button]:w-full [&>button]:justify-start">
                <Plus size={16} style={{ color: "var(--learning)" }} />
                <AddTaskButton />
              </div>
              <button type="button" onClick={act(onCompose)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <PenLine size={16} style={{ color: "var(--social)" }} /> Compose
              </button>
              <button type="button" onClick={act(onYou)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <User size={16} style={{ color: "var(--personal)" }} /> You
              </button>
              <div className="flex items-center gap-3 rounded-xl px-3 py-1 [&>button]:w-full [&>button]:justify-start">
                <Moon size={16} style={{ color: "var(--primary)" }} />
                <BriefingsButton />
              </div>
              <Link to="/workspace/connections" onClick={close}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <Plug size={16} style={{ color: "var(--professional)" }} /> Connect
              </Link>
              <button type="button" onClick={act(onTest)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <Sparkles size={16} style={{ color: "var(--family)" }} /> Test
              </button>
              <Link to="/workspace/personalization" onClick={close}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <Shield size={16} style={{ color: "var(--learning)" }} /> Personalization
              </Link>
              <button type="button" onClick={act(onSignOut)}
                className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-foreground/90 active:bg-secondary">
                <LogOut size={16} className="text-muted-foreground" /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Bento domain card ────────────────────────────────────────────────────────

type UrgencyCounts = { urgent: number; today: number; proactive: number };

function UrgencyBadges({ counts, compact }: { counts: UrgencyCounts; compact?: boolean }) {
  const badges = [
    { n: counts.urgent,    bg: "rgba(248,113,113,0.18)", ring: "rgba(248,113,113,0.45)", color: "#fca5a5", glow: "0 0 6px rgba(248,113,113,0.55)", label: "urgent" },
    { n: counts.today,     bg: "rgba(251,191,36,0.16)",  ring: "rgba(251,191,36,0.4)",   color: "#fcd34d", glow: "0 0 6px rgba(251,191,36,0.45)", label: "today" },
    { n: counts.proactive, bg: "rgba(155,109,250,0.16)", ring: "rgba(155,109,250,0.4)",  color: "#c4b5fd", glow: "0 0 6px rgba(155,109,250,0.45)", label: "proactive" },
  ].filter(b => b.n > 0);
  if (!badges.length) return null;
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {badges.map(b => (
        <span key={b.label} title={`${b.n} ${b.label}`}
          className={`inline-flex items-center gap-1 ${compact?"px-1.5 py-px":"px-2 py-0.5"} rounded-full font-mono text-[9.5px] font-semibold border`}
          style={{background:b.bg, borderColor:b.ring, color:b.color, boxShadow:b.glow}}>
          <span className="w-1 h-1 rounded-full" style={{background:b.color}}/>
          {b.n}
        </span>
      ))}
    </div>
  );
}

function DomainCard({ domain, size, onClick, liveItems, liveCount, urgency, pinned, onTogglePin }: {
  domain:DomainData; size:"xl"|"lg"|"md"|"sm"; onClick:()=>void;
  liveItems?: Array<{ id:string|number; text:string; meta:string; urgent:boolean; progress:number }>;
  liveCount?: number;
  urgency?: UrgencyCounts;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const c=C[domain.id]; const { Icon }=domain;
  const maxItems = size==="xl"?4:size==="lg"?3:size==="md"?2:1;
  const items = liveItems && liveItems.length ? liveItems : domain.items;
  const hasUrgency = urgency && (urgency.urgent + urgency.today + urgency.proactive) > 0;
  const activity = liveCount !== undefined ? Math.min(1, liveCount / 5) : domain.activity;
  return (
    <div onClick={onClick} className={`h-full rounded-2xl border ${c.border} cursor-pointer overflow-hidden flex flex-col p-4 gap-3 transition-all hover:brightness-110 group relative`}
      style={{background:c.tile}}>
      {onTogglePin && (
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          title={pinned ? "Unpin" : "Pin to top"}
          className={`absolute top-2 right-2 z-10 w-6 h-6 rounded-md flex items-center justify-center border transition-all after:content-[''] after:absolute after:-inset-2.5 after:md:hidden ${pinned ? "opacity-100 bg-primary/20 border-primary/40 text-success" : "opacity-0 group-hover:opacity-100 bg-muted border-border text-muted-foreground hover:text-foreground/80 hover:bg-muted"}`}>
          {pinned ? <PinOff size={11}/> : <Pin size={11}/>}
        </button>
      )}
      <div className="flex items-center justify-between flex-shrink-0 gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`,boxShadow:`0 1px 8px ${c.glow}`}}>
            <Icon size={12} style={{color:c.icon}}/>
          </div>
          <span className="text-[12px] font-semibold text-foreground/85 truncate" style={{fontFamily:"var(--font-sans)"}}>{domain.label}</span>
        </div>
        {urgency && hasUrgency ? (
          <UrgencyBadges counts={urgency} compact={size==="sm"}/>
        ) : size!=="sm" && (
          <div className="flex items-center gap-1.5">
            <div className="w-10 h-[2.5px] rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full ${c.bar}`} style={{width:`${activity*100}%`,opacity:0.8}}/>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col gap-1.5 min-h-0 overflow-hidden">
        {items.slice(0,maxItems).map(item=>(
          <div key={item.id} className="flex items-start gap-2.5 min-w-0">
            <span className={`mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.urgent?"bg-red-400 shadow-[0_0_5px_rgba(248,113,113,0.7)]":c.dot}`}/>
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] text-foreground/80 leading-snug truncate" style={{fontFamily:"var(--font-sans)"}}>{item.text}</p>
              {size==="xl" && <p className="text-[10px] text-muted-foreground truncate">{item.meta}</p>}
            </div>
            {item.progress>0 && size==="xl" && <Ring progress={item.progress} color={c.light}/>}
          </div>
        ))}
      </div>

      {size!=="sm" && (
        <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-border">
          <div className="flex gap-1">
            {domain.sources.slice(0,3).map(s=>(
              <span key={s} className="text-[8px] font-mono text-muted-foreground px-1.5 py-px rounded-md bg-muted">{s}</span>
            ))}
          </div>
          <ArrowRight size={10} className="text-muted-foreground/20 group-hover:text-muted-foreground transition-colors"/>
        </div>
      )}
    </div>
  );
}

// ─── Action queue ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<ActionType,{ label:string; dot:string; bg:string; border:string }> = {
  urgent:    { label:"Urgent",    dot:"bg-red-400 shadow-[0_0_5px_rgba(248,113,113,0.8)]",    bg:"rgba(239,68,68,0.05)",     border:"border-red-400/20"   },
  today:     { label:"Today",     dot:"bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.7)]",   bg:"rgba(251,191,36,0.04)",    border:"border-amber-400/15" },
  overdue:   { label:"Overdue",   dot:"bg-orange-400 shadow-[0_0_5px_rgba(251,146,60,0.7)]",  bg:"rgba(251,146,60,0.04)",    border:"border-orange-400/15"},
  proactive: { label:"NC noticed",dot:"bg-primary shadow-[0_0_5px_rgba(155,109,250,0.7)]",    bg:"rgba(155,109,250,0.05)",   border:"border-primary/20"   },
};

function IconBtn({ icon: Icon, label, onClick, color="default" }: {
  icon: React.ElementType; label: string; onClick: ()=>void;
  color?: "default"|"green"|"red"|"amber"|"violet";
}) {
  const colors = {
    default: "text-muted-foreground hover:text-foreground/80 hover:bg-muted hover:border-border",
    green:   "text-muted-foreground hover:text-personal hover:bg-emerald-400/[0.07] hover:border-emerald-400/25",
    red:     "text-muted-foreground hover:text-red-400 hover:bg-red-400/[0.07] hover:border-red-400/20",
    amber:   "text-muted-foreground hover:text-family hover:bg-amber-400/[0.07] hover:border-amber-400/20",
    violet:  "text-muted-foreground hover:text-success hover:bg-primary/[0.08] hover:border-primary/25",
  };
  return (
    <button onClick={onClick} title={label}
      className={`relative w-7 h-7 rounded-lg flex items-center justify-center border border-transparent transition-all flex-shrink-0 after:content-[''] after:absolute after:-inset-2 after:md:hidden ${colors[color]}`}>
      <Icon size={12}/>
    </button>
  );
}

function ActionQueue({ onCompose, onRunOvernight, onDomain }: {
  onCompose:()=>void; onRunOvernight:(text:string)=>void; onDomain:(id:DomainId)=>void;
}) {
  const [dismissed, setDismissed]   = useState<string[]>([]);
  const [confirmed, setConfirmed]   = useState<string[]>([]);
  const [justDone,  setJustDone]    = useState<string[]>([]);
  const [showAll,   setShowAll]     = useState(false);

  const dismiss = (id:string) => {
    setDismissed(d=>[...d,id]);
    setJustDone(d=>[...d,id]);
    setTimeout(()=>setJustDone(d=>d.filter(x=>x!==id)),3500);
  };
  const confirm = (id:string) => {
    setConfirmed(d=>[...d,id]);
    setJustDone(d=>[...d,id]);
    setTimeout(()=>setJustDone(d=>d.filter(x=>x!==id)),3500);
  };
  const undo = (id:string) => { setDismissed(d=>d.filter(x=>x!==id)); setConfirmed(d=>d.filter(x=>x!==id)); setJustDone(d=>d.filter(x=>x!==id)); };

  const done    = [...dismissed,...confirmed];
  const visible = ACTION_QUEUE.filter(a=>!done.includes(a.id));
  const shown   = showAll ? visible : visible.slice(0,4);

  if(!visible.length && !justDone.length) return (
    <div className="flex-shrink-0 rounded-2xl border border-border px-4 py-3 flex items-center gap-3"
      style={{background:"rgba(255,255,255,0.01)"}}>
      <Check size={12} className="text-personal"/>
      <p className="text-[12px] text-muted-foreground" style={{fontFamily:"var(--font-sans)"}}>All clear — nothing urgent right now</p>
    </div>
  );

  return (
    <div className="flex-shrink-0 flex flex-col gap-1.5">
      {/* Undo toasts */}
      {justDone.filter(id=>done.includes(id)).map(id=>{
        const item = ACTION_QUEUE.find(a=>a.id===id); if(!item) return null;
        return (
          <div key={`undo-${id}`} className="flex items-center gap-3 px-4 py-2.5 rounded-2xl border border-border bg-muted">
            <Check size={11} className="text-personal flex-shrink-0"/>
            <p className="text-[11.5px] text-muted-foreground flex-1 truncate" style={{fontFamily:"var(--font-sans)"}}>{item.text}</p>
            <button onClick={()=>undo(id)} className="flex items-center gap-1 text-[10px] font-mono text-success/60 hover:text-success transition-colors flex-shrink-0">
              <RotateCcw size={9}/> undo
            </button>
          </div>
        );
      })}

      {shown.map(item=>{
        const t = TYPE_CONFIG[item.type];
        const c = C[item.domain];
        const DomIcon = DOMAINS[item.domain].Icon;
        return (
          <div key={item.id} className={`group flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all ${t.border}`}
            style={{background:t.bg}}>
            {/* Domain tile */}
            <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`,boxShadow:`0 1px 8px ${c.glow}`}}>
              <DomIcon size={12} style={{color:c.icon}}/>
            </div>
            {/* Text */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.dot}`}/>
                <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">{t.label}</span>
                {item.type==="proactive" && <Lightbulb size={9} className="text-success/50"/>}
              </div>
              <p className="text-[12.5px] text-foreground/88 leading-snug truncate" style={{fontFamily:"var(--font-sans)"}}>{item.text}</p>
              <p className="text-[10.5px] text-muted-foreground mt-0.5 truncate">{item.meta}</p>
            </div>
            {/* Icon actions — visible on hover, always visible on touch */}
            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
              {(item.type==="urgent"||item.type==="overdue") && <>
                <IconBtn icon={PenLine}    label="Compose reply" onClick={onCompose}              color="default"/>
                <IconBtn icon={Check}      label="Mark done"     onClick={()=>confirm(item.id)}   color="green"/>
                <IconBtn icon={X}          label="Dismiss"       onClick={()=>dismiss(item.id)}   color="red"/>
              </>}
              {item.type==="today" && <>
                <IconBtn icon={Check}      label="Confirm done"  onClick={()=>confirm(item.id)}   color="green"/>
                <IconBtn icon={Bell}       label="Snooze"        onClick={()=>dismiss(item.id)}   color="amber"/>
                <IconBtn icon={X}          label="Dismiss"       onClick={()=>dismiss(item.id)}   color="red"/>
              </>}
              {item.type==="proactive" && <>
                <IconBtn icon={Moon}       label="Scout tonight" onClick={()=>{ onRunOvernight(item.text); confirm(item.id); }} color="violet"/>
                <IconBtn icon={Flag}       label="Incorrect"     onClick={()=>dismiss(item.id)}   color="amber"/>
                <IconBtn icon={X}          label="Not now"       onClick={()=>dismiss(item.id)}   color="red"/>
              </>}
            </div>
          </div>
        );
      })}

      {!showAll && visible.length > 4 && (
        <button onClick={()=>setShowAll(true)}
          className="text-[10.5px] text-muted-foreground font-mono hover:text-muted-foreground transition-colors text-left px-1">
          · {visible.length - 4 + ACTION_QUEUE_OVERFLOW} more items across all domains
        </button>
      )}
    </div>
  );
}

type InboxItem = {
  id: string; subject: string; from: string; snippet: string; date: string;
  category: "urgent" | "today" | "proactive" | "ignore" | "needs_review";
  domain: DomainId;
  reason: string;
  classifiedBy?: "rules" | "llm";
};

const CAT_STYLE: Record<InboxItem["category"], { label: string; dot: string; border: string; bg: string }> = {
  urgent:       { label: "Urgent",     dot: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.7)]", border: "border-red-400/25",    bg: "rgba(248,113,113,0.05)" },
  today:        { label: "Today",      dot: "bg-amber-400",                                       border: "border-amber-400/20",  bg: "rgba(251,191,36,0.04)" },
  proactive:    { label: "Proactive",  dot: "bg-violet-400",                                      border: "border-violet-400/20", bg: "rgba(139,92,246,0.04)" },
  needs_review: { label: "Review",     dot: "bg-cyan-400",                                        border: "border-cyan-400/20",   bg: "rgba(34,211,238,0.04)" },
  ignore:       { label: "Low",        dot: "bg-muted-foreground/40",                             border: "border-border",  bg: "rgba(255,255,255,0.015)" },
};

function useInbox() {
  const [items, setItems] = useState<InboxItem[]|null>(null);
  const [error, setError] = useState<string|null>(null);
  useEffect(() => {
    let active = true;
    import("@/lib/gmail.functions").then(({ getInboxItems }) =>
      getInboxItems()
        .then((res) => { if (active) setItems(res.items as InboxItem[]); })
        .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Failed to load inbox"); })
    );
    return () => { active = false; };
  }, []);
  return { items, error };
}

// ─── Voice Drafts (Slice B / Week 3) ──────────────────────────────────────────

type VoiceDraftsStatus = { featureEnabled: boolean; consented: boolean; consentedAt: string | null };

function useVoiceDraftsStatus() {
  const [status, setStatus] = useState<VoiceDraftsStatus | null>(null);
  const refresh = async () => {
    try {
      const { getVoiceDraftsStatus } = await import("@/lib/voice-drafts.functions");
      const s = await getVoiceDraftsStatus();
      setStatus(s);
    } catch {
      setStatus({ featureEnabled: false, consented: false, consentedAt: null });
    }
  };
  useEffect(() => { void refresh(); }, []);
  return { status, refresh };
}

function ConsentModal({ open, onClose, onAccepted }: { open: boolean; onClose: () => void; onAccepted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return null;
  async function accept() {
    setBusy(true); setErr(null);
    try {
      const { setVoiceDraftsConsent } = await import("@/lib/voice-drafts.functions");
      await setVoiceDraftsConsent({ data: { accept: true } });
      onAccepted();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save consent");
    } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl glass-elevated p-5">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={14} className="text-success"/>
          <h2 className="text-sm font-semibold tracking-tight font-display">Turn on Voice Drafts</h2>
        </div>
        <p className="text-[12.5px] text-foreground/80 mb-3 leading-relaxed">
          Before NeuralConnexions writes replies in your voice, please read what this involves:
        </p>
        <ul className="text-[12px] text-foreground/75 leading-relaxed space-y-2 mb-4 list-disc pl-4">
          <li>The email's <strong>sender, subject and full text</strong> (up to 4,000 characters), your answers to the check-in questions and, when the email is about meeting up, your free times go to <strong>Google's Gemini model through Lovable's AI gateway</strong>: once to understand the email and once to write the draft.</li>
          <li>To learn your style, our server reads up to <strong>200 of your sent emails</strong> and keeps a short profile (sign-off, openers, sentence length, formality and up to 20 typical phrases) for <strong>7 days</strong>. Up to 8 of those phrases and 3 openers go with each draft request; the emails themselves aren't sent to any AI service.</li>
          <li>Drafts are saved <strong>encrypted</strong> in your account. <strong>Nothing is sent automatically</strong>: every reply needs your click.</li>
        </ul>
        {err && <p className="text-[11px] text-social/80 mb-2">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-muted-foreground/80 hover:bg-muted hover:text-foreground disabled:opacity-50">
            Not now
          </button>
          <button onClick={accept} disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-primary/15 text-success ring-1 ring-primary/30 hover:bg-primary/20 disabled:opacity-50">
            {busy ? "Saving…" : "I understand, enable"}
          </button>
        </div>
      </div>
    </div>
  );
}

type DraftDisplay = {
  id: string;
  body: string;
  charsInDraft: number;
  template: string;
  assistantNote?: string;
  proposedSlots?: { startIso: string; endIso: string; human: string }[];
  followUp?: { afterDays: number; summary: string };
};

type PrepBlockState =
  | { phase: "idle" }
  | { phase: "blocking" }
  | { phase: "done"; human: string; htmlLink: string }
  | { phase: "error"; reason: "scope" | "no_calendar" | "create_failed"; message: string };

// Same shape as PrepBlockState — both wrap createCalendarEvent results.
type FollowUpState = PrepBlockState;

// Cross-thread context brief, fetched on demand via the
// `research_thread_context` agent tool.
type ContextState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; brief: string; sourceCount: number }
  | { phase: "no_history" }
  | { phase: "error"; message: string };

// Overnight-research enqueue state for the draft panel chip. Distinct from
// ContextState because the user can both schedule overnight AND get a fresh
// context brief now — they're independent flows over the same agent tool.
type ScheduleState =
  | { phase: "idle" }
  | { phase: "enqueuing" }
  | { phase: "scheduled"; whenHuman: string }
  | { phase: "duplicate" }
  | { phase: "error"; message: string };

type AssistantQuestion = { id: string; question: string; placeholder: string };

function useDraftReply(item: InboxItem, consented: boolean, onRequestConsent: () => Promise<boolean>) {
  const [phase, setPhase] = useState<"idle" | "analyzing" | "asking" | "generating" | "open" | "sending">("idle");
  const [draft, setDraft] = useState<DraftDisplay | null>(null);
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [questions, setQuestions] = useState<AssistantQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pendingNote, setPendingNote] = useState<string>("");
  // Carries the optional follow-up suggestion from analyzeDraft → draftReply,
  // so the draft panel can render the "Remind me in N days" chip without an
  // extra round trip.
  const [pendingFollowUp, setPendingFollowUp] = useState<{ afterDays: number; summary: string } | undefined>(undefined);
  // Monotonic request id — every async action increments it. Resolutions
  // whose id no longer matches the current `reqRef` are ignored, so a
  // double-click or rapid skip→submit can't write stale state.
  const reqRef = useRef(0);

  function extractEmail(s: string): string {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim();
  }

  const [prepBlock, setPrepBlock] = useState<PrepBlockState>({ phase: "idle" });
  const [followUp, setFollowUp] = useState<FollowUpState>({ phase: "idle" });
  // Synchronous double-click guard for follow-up creation. React state alone
  // isn't enough — two rapid clicks can both observe phase: "idle" before the
  // first re-render commits, leading to two calendar events.
  const followUpInFlight = useRef(false);
  const [contextBrief, setContextBrief] = useState<ContextState>({ phase: "idle" });
  // Same double-click guard pattern as follow-up — synthesis is idempotent so
  // a second call wouldn't cause damage, but it would burn tokens for nothing.
  const contextInFlight = useRef(false);
  const [scheduleState, setScheduleState] = useState<ScheduleState>({ phase: "idle" });
  const scheduleInFlight = useRef(false);
  // Per-question UX state for the availability suggestion button.
  // "loading" → fetching from calendar; "empty" → no slots returned (so we hide
  // the button next time); "error" → soft failure note; "idle" → button visible.
  const [availSuggest, setAvailSuggest] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "empty" }
    | { status: "no_calendar" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  // Slots fetched from calendar, kept around so we can render them as
  // toggleable chips. Source of truth for "is this slot in the answer?" is the
  // answer string itself (plain substring check), so the chip stays in sync if
  // the user edits the text manually.
  const [availSlots, setAvailSlots] = useState<{ startIso: string; human: string }[]>([]);
  // Hard guard against double-submit before React commits the loading state.
  const availInFlight = useRef(false);

  async function suggestAvailabilityFromCalendar(questionId: string) {
    if (availInFlight.current) return;
    availInFlight.current = true;
    setAvailSuggest({ status: "loading" });
    try {
      const { suggestAvailability } = await import("@/lib/voice-drafts.functions");
      const r = await suggestAvailability({
        data: { prepTimeText: answers.prep_time?.trim() || undefined },
      });
      if (r.status === "ok") {
        setAvailSlots(r.slots.map((s) => ({ startIso: s.startIso, human: s.human })));
        setAnswers((a) => ({ ...a, [questionId]: r.answer }));
        setAvailSuggest({ status: "idle" });
      } else if (r.status === "empty") {
        // Clear any stale chips from a previous successful fetch — otherwise
        // a refresh that returns no slots would still display the old ones.
        setAvailSlots([]);
        setAvailSuggest({ status: "empty" });
      } else if (r.status === "no_calendar") {
        setAvailSlots([]);
        setAvailSuggest({ status: "no_calendar" });
      } else {
        setAvailSuggest({ status: "error", message: r.message });
      }
    } catch (e) {
      console.warn("suggestAvailability failed:", e);
      setAvailSlots([]);
      setAvailSuggest({
        status: "error",
        message: e instanceof Error ? e.message : "calendar lookup failed",
      });
    } finally {
      availInFlight.current = false;
    }
  }

  async function runDraft(clarifications?: Record<string, string>, assistantNote?: string) {
    const myReq = ++reqRef.current;
    setPhase("generating");
    setErr(null);
    setPrepBlock({ phase: "idle" });
    setFollowUp({ phase: "idle" });
    setContextBrief({ phase: "idle" });
    setScheduleState({ phase: "idle" });
    try {
      const { draftReply } = await import("@/lib/voice-drafts.functions");
      const d = await draftReply({
        data: { memoryNodeId: item.id, clarifications, assistantNote, followUp: pendingFollowUp },
      });
      if (myReq !== reqRef.current) return; // superseded
      setDraft({
        id: d.id,
        body: d.body,
        charsInDraft: d.charsInDraft,
        template: d.template,
        assistantNote: d.assistantNote ?? assistantNote,
        proposedSlots: d.proposedSlots,
        followUp: d.followUp,
      });
      setBody(d.body);
      setPhase("open");
    } catch (e) {
      if (myReq !== reqRef.current) return;
      setErr(e instanceof Error ? e.message : "Draft failed");
      setPhase(clarifications ? "asking" : "idle");
    }
  }

  async function startDraft() {
    if (phase !== "idle") return; // guard against double-click
    const myReq = ++reqRef.current;
    setErr(null);
    if (!consented) {
      const ok = await onRequestConsent();
      if (!ok || myReq !== reqRef.current) return;
    }
    setPhase("analyzing");
    try {
      const { analyzeDraft } = await import("@/lib/voice-drafts.functions");
      const a = await analyzeDraft({ data: { memoryNodeId: item.id } });
      if (myReq !== reqRef.current) return;
      setPendingNote(a.assistantNote);
      setPendingFollowUp(a.followUp);
      if (a.questions.length > 0) {
        setQuestions(a.questions);
        setAnswers(Object.fromEntries(a.questions.map((q) => [q.id, ""])));
        setPhase("asking");
      } else {
        await runDraft(undefined, a.assistantNote);
      }
    } catch (e) {
      if (myReq !== reqRef.current) return;
      // Analyze failed → degrade to old direct-draft path so the user
      // is never blocked by a flaky pre-step.
      console.warn("analyzeDraft failed, falling back to direct draft:", e);
      await runDraft();
    }
  }

  async function submitAnswers() {
    await runDraft(answers, pendingNote);
  }

  async function skipQuestions() {
    await runDraft(undefined, pendingNote);
  }

  async function regenerate() {
    if (!draft) return;
    setErr(null);
    // Regenerated draft may have a new earliest slot → wipe stale prep-block state.
    setPrepBlock({ phase: "idle" });
    // NOTE: deliberately do NOT reset followUp here. The follow-up suggestion
    // is about the *email*, not the draft body, so a regenerate shouldn't let
    // the user create a second reminder. State is reset on dismiss + redraft.
    setPhase("generating");
    try {
      const { regenerateDraft } = await import("@/lib/voice-drafts.functions");
      const d = await regenerateDraft({
        data: { draftId: draft.id, clarifications: Object.keys(answers).length ? answers : undefined },
      });
      setDraft({
        id: d.id,
        body: d.body,
        charsInDraft: d.charsInDraft,
        template: d.template,
        assistantNote: draft.assistantNote,
        proposedSlots: d.proposedSlots ?? draft.proposedSlots,
        followUp: draft.followUp,
      });
      setBody(d.body);
      setPhase("open");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Regenerate failed");
      setPhase("open");
    }
  }

  async function blockPrepTime() {
    if (!draft) return;
    // Idempotency guard: if a previous block call is in flight or already
    // succeeded for this draft, don't issue another. (User can dismiss + redraft
    // to start over.)
    if (prepBlock.phase === "blocking" || prepBlock.phase === "done") return;
    const earliest = draft.proposedSlots?.[0];
    const prep = answers.prep_time?.trim();
    if (!earliest || !prep) return;
    setPrepBlock({ phase: "blocking" });
    try {
      const { createPrepBlock } = await import("@/lib/voice-drafts.functions");
      const r = await createPrepBlock({
        data: { draftId: draft.id, beforeIso: earliest.startIso, prepTimeText: prep },
      });
      if (r.ok) {
        setPrepBlock({ phase: "done", human: r.human, htmlLink: r.htmlLink });
      } else {
        setPrepBlock({ phase: "error", reason: r.reason, message: r.message });
      }
    } catch (e) {
      setPrepBlock({
        phase: "error",
        reason: "create_failed",
        message: e instanceof Error ? e.message : "Failed to block prep time",
      });
    }
  }

  const toAddr = extractEmail(item.from);
  const subj = item.subject.startsWith("Re:") ? item.subject : `Re: ${item.subject}`;
  // Deep-link compose URL. Works fine in production but the Replit dev preview
  // iframe propagates Cross-Origin-Embedder-Policy to popups → Gmail returns
  // ERR_BLOCKED_BY_RESPONSE in the new tab. We hide the link when inside any
  // iframe; Copy is always the safe primary action.
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toAddr)}&su=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
  const mailtoUrl = `mailto:${toAddr}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
  const [copied, setCopied] = useState(false);
  const inIframe = typeof window !== "undefined" && window.self !== window.top;

  async function copyAndMarkSent() {
    if (!draft) return;
    setPhase("sending");
    setErr(null);
    try {
      await navigator.clipboard.writeText(body);
      const { markDraftSent } = await import("@/lib/voice-drafts.functions");
      await markDraftSent({ data: { draftId: draft.id, finalBody: body } });
      setCopied(true);
      setPhase("open");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Copy/send failed");
      setPhase("open");
    }
  }

  async function dismiss() {
    if (draft) {
      try {
        const { dismissDraft } = await import("@/lib/voice-drafts.functions");
        await dismissDraft({ data: { draftId: draft.id } });
      } catch { /* keep UI moving */ }
    }
    setDraft(null);
    setQuestions([]);
    setAnswers({});
    setPendingNote("");
    setPendingFollowUp(undefined);
    setPrepBlock({ phase: "idle" });
    setFollowUp({ phase: "idle" });
    setContextBrief({ phase: "idle" });
    setScheduleState({ phase: "idle" });
    // Drop the in-flight guard too — without this, dismissing while a context
    // request is mid-air would leave the ref true and block the next click
    // even after a fresh draft is opened.
    contextInFlight.current = false;
    scheduleInFlight.current = false;
    setAvailSuggest({ status: "idle" });
    setAvailSlots([]);
    setPhase("idle");
  }

  /**
   * Fetch a 2-3 sentence strategic brief about the sender from local memory.
   * Goes through the generic `runAgentTool` dispatcher (rather than calling a
   * dedicated server fn) to demonstrate that any feature can use the same
   * surface — chat agent, command palette, etc. would call it the same way.
   */
  async function researchContext() {
    if (!draft?.id) return;
    if (contextInFlight.current) return;
    if (contextBrief.phase === "loading" || contextBrief.phase === "ok") return;
    // Capture the draft id at call time. If the panel is dismissed or a new
    // draft is generated before the LLM responds, draft.id will differ on
    // resolution and we drop the stale result instead of writing it into the
    // wrong draft's UI state.
    const draftIdAtCall = draft.id;
    contextInFlight.current = true;
    setContextBrief({ phase: "loading" });
    try {
      const { runAgentTool } = await import("@/lib/voice-drafts.functions");
      const r = await runAgentTool({
        data: { toolId: "research_thread_context", input: { draftId: draftIdAtCall } },
      });
      if (draft?.id !== draftIdAtCall) return; // superseded
      if (!r.ok) {
        setContextBrief({ phase: "error", message: r.error });
        return;
      }
      const result = r.result as
        | { status: "ok"; brief: string; sourceCount: number }
        | { status: "no_history" }
        | { status: "error"; message: string };
      if (result.status === "ok") {
        setContextBrief({ phase: "ok", brief: result.brief, sourceCount: result.sourceCount });
      } else if (result.status === "no_history") {
        setContextBrief({ phase: "no_history" });
      } else {
        setContextBrief({ phase: "error", message: result.message });
      }
    } catch (e) {
      if (draft?.id !== draftIdAtCall) return;
      setContextBrief({
        phase: "error",
        message: e instanceof Error ? e.message : "Failed to research context",
      });
    } finally {
      contextInFlight.current = false;
    }
  }

  /**
   * Enqueue a research_thread_context task for overnight execution instead of
   * running it now. Demonstrates the same agent-tool surface used by the
   * Context chip, but routed through the persistent research queue so the
   * brief is ready in the morning without burning the user's wait time now.
   *
   * "Tonight" = next 03:00 in the browser's local timezone — far enough into
   * the night that the cron worker (when wired) won't compete with daytime
   * traffic, and far enough from "now" that batching multiple drafts during
   * a triage session coalesces nicely.
   */
  async function scheduleResearchOvernight() {
    if (!draft?.id) return;
    if (scheduleInFlight.current) return;
    if (scheduleState.phase === "enqueuing" || scheduleState.phase === "scheduled" || scheduleState.phase === "duplicate") return;
    // Snapshot the draft id so a mid-flight dismiss/switch can't write
    // "scheduled/duplicate/error" onto the wrong panel — same pattern the
    // researchContext flow uses to guard its async setState.
    const draftIdAtCall = draft.id;
    scheduleInFlight.current = true;
    setScheduleState({ phase: "enqueuing" });
    const tonight = new Date();
    tonight.setHours(3, 0, 0, 0);
    if (tonight.getTime() <= Date.now()) tonight.setDate(tonight.getDate() + 1);
    const whenHuman = tonight.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    try {
      const { enqueueResearchTaskFn } = await import("@/lib/voice-drafts.functions");
      const r = await enqueueResearchTaskFn({
        data: {
          toolId: "research_thread_context",
          input: { draftId: draftIdAtCall },
          source: "manual",
          sourceContext: `Draft reply triage — ${item.subject || item.from}`,
          priority: 80,
          scheduledFor: tonight.toISOString(),
        },
      });
      if (draftIdAtCall !== draft?.id) return;
      if (r.status === "enqueued") setScheduleState({ phase: "scheduled", whenHuman });
      else if (r.status === "duplicate") setScheduleState({ phase: "duplicate" });
      else setScheduleState({ phase: "error", message: r.message });
    } catch (e) {
      if (draftIdAtCall !== draft?.id) return;
      setScheduleState({
        phase: "error",
        message: e instanceof Error ? e.message : "Failed to schedule research",
      });
    } finally {
      scheduleInFlight.current = false;
    }
  }

  async function scheduleFollowUp() {
    if (!draft?.followUp) return;
    if (followUpInFlight.current) return;
    if (followUp.phase === "blocking" || followUp.phase === "done") return;
    followUpInFlight.current = true;
    setFollowUp({ phase: "blocking" });
    try {
      const { createFollowUpReminder } = await import("@/lib/voice-drafts.functions");
      const r = await createFollowUpReminder({
        data: { afterDays: draft.followUp.afterDays, summary: draft.followUp.summary },
      });
      if (r.ok) {
        setFollowUp({ phase: "done", human: r.human, htmlLink: r.htmlLink });
      } else {
        setFollowUp({ phase: "error", reason: r.reason, message: r.message });
      }
    } catch (e) {
      setFollowUp({
        phase: "error",
        reason: "create_failed",
        message: e instanceof Error ? e.message : "Failed to set reminder",
      });
    } finally {
      followUpInFlight.current = false;
    }
  }

  /**
   * Toggle a single calendar-suggested slot in/out of the answer string.
   * Avoids the "delete the wrong character and corrupt the list" footgun
   * users hit when editing the prefilled string by hand.
   */
  function toggleAvailSlot(questionId: string, human: string) {
    setAnswers((a) => {
      const cur = a[questionId] ?? "";
      const present = cur.includes(human);
      let next: string;
      if (present) {
        // Remove the slot string, plus a leading or trailing "; " separator
        // if present, then collapse any double separators we left behind.
        next = cur
          .replace(`${human}; `, "")
          .replace(`; ${human}`, "")
          .replace(human, "")
          .replace(/;\s*;/g, ";")
          .replace(/^;\s*|\s*;\s*$/g, "")
          .trim();
      } else {
        next = cur.trim() ? `${cur.trim()}; ${human}` : human;
      }
      return { ...a, [questionId]: next };
    });
  }

  const button =
    phase === "analyzing" ? (
      <span className="text-[10.5px] font-mono text-muted-foreground px-2">Reading…</span>
    ) : phase === "generating" ? (
      <span className="text-[10.5px] font-mono text-muted-foreground px-2">Drafting…</span>
    ) : phase === "idle" ? (
      <button onClick={startDraft}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium text-success/85 hover:bg-primary/10 ring-1 ring-primary/25 transition-colors"
        title="Draft a reply in your voice">
        <Sparkles size={11}/> Draft reply
      </button>
    ) : (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium text-success/70 ring-1 ring-primary/25">
        <Sparkles size={11}/> {phase === "asking" ? "Quick check" : "Drafted"}
      </span>
    );

  const askingPanel = phase === "asking" ? (
    <div className="w-full mt-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Sparkles size={11} className="text-success"/>
        <span className="text-[9px] font-mono uppercase tracking-wider text-success/70">Assistant check-in</span>
        {err && <span className="text-[10px] text-social/80 ml-auto">{err}</span>}
      </div>
      {pendingNote && (
        <p className="text-[12px] text-foreground/75 leading-relaxed" style={{fontFamily:"var(--font-sans)"}}>
          {pendingNote}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {questions.map((q) => {
          const isAvailability = q.id === "availability";
          // Only offer the calendar suggestion once we know how much prep time
          // the user wants (otherwise the buffer is meaningless for interviews).
          // For non-interview emails (no prep_time question at all) we still
          // offer it using the default 2-hour buffer.
          const hasPrepTimeQuestion = questions.some((x) => x.id === "prep_time");
          const prepFilled = !!answers.prep_time?.trim();
          const prepNeeded = isAvailability && hasPrepTimeQuestion && !prepFilled;
          const canSuggest = isAvailability && !prepNeeded;
          return (
            <label key={q.id} className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground/80">{q.question}</span>
              <input
                type="text"
                value={answers[q.id] ?? ""}
                placeholder={q.placeholder}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                className="bg-transparent border border-border rounded-md px-2 py-1.5 text-[12px] text-foreground/90 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {prepNeeded && (
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  Answer prep time first to use your calendar.
                </span>
              )}
              {canSuggest && isAvailability && availSlots.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {availSlots.map((s) => {
                    const inAnswer = (answers[q.id] ?? "").includes(s.human);
                    return (
                      <button
                        key={s.startIso}
                        type="button"
                        onClick={() => toggleAvailSlot(q.id, s.human)}
                        className={
                          inAnswer
                            ? "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] bg-primary/15 text-success/90 ring-1 ring-primary/30 hover:bg-primary/20"
                            : "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] text-muted-foreground ring-1 ring-white/[0.08] hover:ring-primary/30 hover:text-foreground/75"
                        }
                        title={inAnswer ? "Remove from reply" : "Add to reply"}
                      >
                        {s.human}
                        {inAnswer ? <X size={9}/> : <Plus size={9}/>}
                      </button>
                    );
                  })}
                </div>
              )}
              {canSuggest && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  {availSuggest.status === "idle" && availSlots.length === 0 && (
                    <button
                      type="button"
                      onClick={() => suggestAvailabilityFromCalendar(q.id)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-success/75 hover:bg-primary/10 hover:text-success"
                    >
                      <CalendarDays size={10}/> Use my calendar
                    </button>
                  )}
                  {availSuggest.status === "idle" && availSlots.length > 0 && (
                    <button
                      type="button"
                      onClick={() => suggestAvailabilityFromCalendar(q.id)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground/75"
                      title="Re-fetch free slots from your calendar"
                    >
                      <RefreshCw size={9}/> Refresh
                    </button>
                  )}
                  {availSuggest.status === "loading" && (
                    <span className="text-[10.5px] font-mono text-muted-foreground">
                      Checking your calendar…
                    </span>
                  )}
                  {availSuggest.status === "empty" && (
                    <span className="text-[10.5px] text-muted-foreground">
                      No free slots in the next week — type your own.
                    </span>
                  )}
                  {availSuggest.status === "no_calendar" && (
                    <span className="text-[10.5px] text-muted-foreground inline-flex items-center gap-1">
                      Calendar not connected.{" "}
                      <Link to="/workspace/connections" className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                        Connect →
                      </Link>
                    </span>
                  )}
                  {availSuggest.status === "error" && (
                    <span className="text-[10.5px] text-social/70">
                      Couldn't reach calendar — type your own.
                    </span>
                  )}
                </div>
              )}
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <button onClick={submitAnswers} disabled={phase !== "asking"}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary/20 text-success ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
          <Sparkles size={11}/> Draft with this
        </button>
        <button onClick={skipQuestions} disabled={phase !== "asking"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
          Skip & draft anyway
        </button>
        <button onClick={dismiss}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground ml-auto">
          <X size={11}/> Cancel
        </button>
      </div>
    </div>
  ) : null;

  const panel = (phase === "open" || phase === "sending") ? (
    <div className="w-full mt-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Sparkles size={11} className="text-success"/>
        <span className="text-[9px] font-mono uppercase tracking-wider text-success/70">{draft?.template} draft</span>
        {err && <span className="text-[10px] text-social/80 ml-auto">{err}</span>}
      </div>
      {draft?.assistantNote && (
        <div className="rounded-lg border border-primary/15 bg-primary/[0.05] px-2.5 py-2">
          <p className="text-[11.5px] text-foreground/75 leading-relaxed italic" style={{fontFamily:"var(--font-sans)"}}>
            {draft.assistantNote}
          </p>
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(12, Math.max(4, body.split("\n").length + 1))}
        className="w-full bg-transparent border border-border rounded-lg p-2 text-[12.5px] text-foreground/90 font-sans leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        <button onClick={copyAndMarkSent}
          disabled={phase === "sending" || !body.trim() || copied}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary/20 text-success ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
          <Check size={11}/> {copied ? "Copied & marked sent" : phase === "sending" ? "Saving…" : "Copy reply & mark sent"}
        </button>
        {!inIframe && (
          <a href={gmailUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-muted hover:text-foreground">
            <Send size={11}/> Open Gmail
          </a>
        )}
        <a href={mailtoUrl}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-muted hover:text-foreground">
          mailto…
        </a>
        {inIframe && copied && (
          <span className="text-[10.5px] text-muted-foreground px-1">
            Paste into Gmail in another tab. (Direct link works in your deployed app, blocked in this preview.)
          </span>
        )}
        <button onClick={regenerate} disabled={phase === "sending"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-muted hover:text-foreground disabled:opacity-50">
          <RefreshCw size={11}/> Regenerate
        </button>
        <button onClick={dismiss} disabled={phase === "sending"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 ml-auto">
          <X size={11}/> Dismiss
        </button>
      </div>
      {/* Cross-thread context brief — synthesizes prior interactions with this
          sender into a 2-3 sentence read. Always offered (the sender is known
          by definition once a draft exists), but loads lazily on click. */}
      {draft && (
        <div className="border-t border-border pt-2 mt-1 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {(contextBrief.phase === "idle" || contextBrief.phase === "error") && (
              <button onClick={researchContext}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-success/85 hover:bg-primary/10 ring-1 ring-primary/25"
                title="Synthesize a brief about this sender from your prior threads">
                <BookOpen size={11}/> Context on this sender
              </button>
            )}
            {contextBrief.phase === "loading" && (
              <span className="text-[10.5px] font-mono text-muted-foreground">Reading prior threads…</span>
            )}
            {contextBrief.phase === "no_history" && (
              <span className="text-[10.5px] text-muted-foreground inline-flex items-center gap-1.5">
                <BookOpen size={11}/> No prior history with this sender.
              </span>
            )}
            {contextBrief.phase === "ok" && (
              <span className="text-[10.5px] text-muted-foreground inline-flex items-center gap-1.5">
                <BookOpen size={11}/> Context · {contextBrief.sourceCount} prior thread{contextBrief.sourceCount === 1 ? "" : "s"}
              </span>
            )}
            {contextBrief.phase === "error" && (
              <span className="text-[10.5px] text-social/80">Couldn't load: {contextBrief.message}</span>
            )}
            {/* Defer-to-overnight twin chip. Cheap to use repeatedly because
                the queue dedupes — clicking after a duplicate is a no-op. */}
            {scheduleState.phase === "idle" && (
              <button onClick={scheduleResearchOvernight}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-muted hover:text-foreground"
                title="Queue this research for the overnight batch instead of running it now">
                <Bell size={11}/> Research overnight
              </button>
            )}
            {scheduleState.phase === "enqueuing" && (
              <span className="text-[10.5px] font-mono text-muted-foreground">Scheduling…</span>
            )}
            {scheduleState.phase === "scheduled" && (
              <span className="text-[10.5px] text-personal/80 inline-flex items-center gap-1.5">
                <Check size={11}/> Queued for {scheduleState.whenHuman}
              </span>
            )}
            {scheduleState.phase === "duplicate" && (
              <span className="text-[10.5px] text-muted-foreground inline-flex items-center gap-1.5">
                <Check size={11}/> Already in tonight's queue
              </span>
            )}
            {scheduleState.phase === "error" && (
              <span className="text-[10.5px] text-social/80">Couldn't queue: {scheduleState.message}</span>
            )}
          </div>
          {contextBrief.phase === "ok" && (
            <p className="text-[11.5px] leading-relaxed text-foreground/80 italic px-1 border-l-2 border-primary/30 pl-2">
              {contextBrief.brief}
            </p>
          )}
        </div>
      )}
      {/* Prep-block follow-up: only when we have both a meeting slot to anchor
          on AND the user told us how much prep time they want. */}
      {draft?.proposedSlots && draft.proposedSlots.length > 0 && answers.prep_time?.trim() && (
        <div className="border-t border-border pt-2 mt-1 flex items-center gap-2 flex-wrap">
          {prepBlock.phase === "idle" && (
            <button onClick={blockPrepTime}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-success/85 hover:bg-primary/10 ring-1 ring-primary/25">
              <CalendarDays size={11}/> Block prep time on my calendar
            </button>
          )}
          {prepBlock.phase === "blocking" && (
            <span className="text-[10.5px] font-mono text-muted-foreground">Blocking prep time…</span>
          )}
          {prepBlock.phase === "done" && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-personal/85">
              <Check size={11}/> Prep blocked: {prepBlock.human}
              {prepBlock.htmlLink && (
                <a href={prepBlock.htmlLink} target="_blank" rel="noopener noreferrer"
                  className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                  Open in Calendar →
                </a>
              )}
            </span>
          )}
          {prepBlock.phase === "error" && (
            <span className="text-[10.5px] text-social/80 inline-flex items-center gap-1.5">
              {prepBlock.reason === "scope" ? (
                <>Google Calendar is connected with read-only access.{" "}
                  <Link to="/workspace/connections" className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                    Reconnect to enable event creation →
                  </Link>
                </>
              ) : prepBlock.reason === "no_calendar" ? (
                <>No calendar connected.{" "}
                  <Link to="/workspace/connections" className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                    Connect Google Calendar →
                  </Link>
                </>
              ) : (
                <>Couldn't block prep time: {prepBlock.message}</>
              )}
            </span>
          )}
        </div>
      )}
      {/* Follow-up reminder: optional one-click chip surfaced when the assistant
          thinks this thread is worth coming back to (decisions, sales chases). */}
      {draft?.followUp && (
        <div className="border-t border-border pt-2 mt-1 flex items-center gap-2 flex-wrap">
          {followUp.phase === "idle" && (
            <button onClick={scheduleFollowUp}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-success/85 hover:bg-primary/10 ring-1 ring-primary/25"
              title={`"${draft.followUp.summary}" — adds a 30-min hold at 9 AM, ${draft.followUp.afterDays} day${draft.followUp.afterDays === 1 ? "" : "s"} from now`}
            >
              <BellRing size={11}/> Remind me in {draft.followUp.afterDays} day{draft.followUp.afterDays === 1 ? "" : "s"}
            </button>
          )}
          {followUp.phase === "blocking" && (
            <span className="text-[10.5px] font-mono text-muted-foreground">Setting reminder…</span>
          )}
          {followUp.phase === "done" && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-personal/85">
              <Check size={11}/> Reminder set: {followUp.human}
              {followUp.htmlLink && (
                <a href={followUp.htmlLink} target="_blank" rel="noopener noreferrer"
                  className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                  Open in Calendar →
                </a>
              )}
            </span>
          )}
          {followUp.phase === "error" && (
            <span className="text-[10.5px] text-social/80 inline-flex items-center gap-1.5">
              {followUp.reason === "scope" ? (
                <>Google Calendar is connected with read-only access.{" "}
                  <Link to="/workspace/connections" className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                    Reconnect to enable event creation →
                  </Link>
                </>
              ) : followUp.reason === "no_calendar" ? (
                <>No calendar connected.{" "}
                  <Link to="/workspace/connections" className="text-success/80 hover:text-success underline-offset-2 hover:underline">
                    Connect Google Calendar →
                  </Link>
                </>
              ) : (
                <>Couldn't set reminder: {followUp.message}</>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  ) : null;

  return { button, panel: askingPanel ?? panel };
}

function InboxRow({
  item,
  c,
  s,
  consented,
  onRequestConsent,
  onCompose,
  onMarkDone,
  draftable,
}: {
  item: InboxItem;
  c: typeof C[DomainId];
  s: typeof CAT_STYLE[InboxItem["category"]];
  consented: boolean;
  onRequestConsent: () => Promise<boolean>;
  onCompose: () => void;
  onMarkDone: () => void;
  draftable: boolean;
}) {
  const draft = useDraftReply(item, consented, onRequestConsent);
  return (
    <div className={`group rounded-2xl border ${s.border} px-4 py-3 transition-all hover:brightness-110`}
      style={{background:s.bg}}>
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`,boxShadow:`0 1px 8px ${c.glow}`}}>
          <Mail size={12} style={{color:c.icon}}/>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`}/>
            <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">{s.label}</span>
            {item.reason && <span className="text-[9px] text-muted-foreground truncate">· {item.reason}</span>}
          </div>
          <p className="text-[12.5px] text-foreground/88 leading-snug truncate" style={{fontFamily:"var(--font-sans)"}}>{item.subject}</p>
          <p className="text-[10.5px] text-muted-foreground mt-0.5 truncate">{item.from}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-90 group-hover:opacity-100 transition-opacity">
          {draftable && draft.button}
          <IconBtn icon={PenLine} label="Compose reply" onClick={onCompose} color="default"/>
          <IconBtn icon={Check}   label="Mark done"     onClick={onMarkDone} color="green"/>
        </div>
      </div>
      {draft.panel}
    </div>
  );
}

function InboxQueue({ onCompose, items, error }: { onCompose:()=>void; items: InboxItem[]|null; error: string|null }) {
  const [done, setDone] = useState<string[]>([]);
  const [showLow, setShowLow] = useState(false);
  const { status, refresh } = useVoiceDraftsStatus();
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolverRef = useRef<((ok: boolean) => void) | null>(null);

  const requestConsent = async (): Promise<boolean> => {
    setConsentOpen(true);
    return new Promise<boolean>((resolve) => { consentResolverRef.current = resolve; });
  };
  const closeConsent = (accepted: boolean) => {
    setConsentOpen(false);
    consentResolverRef.current?.(accepted);
    consentResolverRef.current = null;
  };

  if (error) {
    return (
      <div className="flex-shrink-0 rounded-2xl border border-rose-400/20 bg-rose-500/[0.04] px-4 py-3">
        <p className="text-[11.5px] text-social/80">Couldn't load inbox: {error}</p>
        <Link to="/workspace/connections" className="text-[10.5px] text-success/70 font-mono hover:text-success">Connect Gmail →</Link>
      </div>
    );
  }
  if (!items) {
    return <div className="flex-shrink-0 rounded-2xl border border-border px-4 py-3 text-[11.5px] text-muted-foreground">Loading inbox…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="flex-shrink-0 rounded-2xl border border-border px-4 py-3 flex items-center gap-3">
        <Inbox size={12} className="text-muted-foreground"/>
        <p className="text-[12px] text-muted-foreground flex-1" style={{fontFamily:"var(--font-sans)"}}>No inbox items yet.</p>
        <Link to="/workspace/connections" className="text-[10.5px] text-success/70 font-mono hover:text-success whitespace-nowrap">Pull emails →</Link>
      </div>
    );
  }

  const remaining = items.filter(i => !done.includes(i.id));
  const priority  = remaining.filter(i => i.category !== "ignore");
  const low       = remaining.filter(i => i.category === "ignore");
  const visible   = showLow ? remaining : priority;
  const c = C.professional;

  return (
    <div className="flex-shrink-0 flex flex-col gap-1.5">
      {visible.length === 0 && (
        <div className="rounded-2xl border border-border px-4 py-3 flex items-center gap-3">
          <Check size={12} className="text-personal"/>
          <p className="text-[12px] text-muted-foreground" style={{fontFamily:"var(--font-sans)"}}>All clear — nothing urgent right now</p>
        </div>
      )}
      {visible.map(item => {
        const s = CAT_STYLE[item.category];
        const draftable = item.category !== "ignore"
          && (status?.featureEnabled ?? true);
        return (
          <InboxRow
            key={item.id}
            item={item}
            c={c}
            s={s}
            consented={status?.consented ?? false}
            onRequestConsent={requestConsent}
            onCompose={onCompose}
            onMarkDone={() => {
              setDone(d => [...d, item.id]);
              import("@/lib/gmail.functions").then(({ markInboxItemDone }) =>
                markInboxItemDone({ data: { id: item.id, action: "done" } })
              ).catch((e) => {
                console.error("markInboxItemDone failed:", e);
                setDone(d => d.filter(x => x !== item.id));
              });
            }}
            draftable={draftable}
          />
        );
      })}
      {!showLow && low.length > 0 && (
        <button onClick={()=>setShowLow(true)}
          className="text-[10.5px] text-muted-foreground font-mono hover:text-muted-foreground transition-colors text-left px-1">
          · {low.length} low-priority {low.length === 1 ? "item" : "items"}
        </button>
      )}
      <ConsentModal
        open={consentOpen}
        onClose={() => closeConsent(false)}
        onAccepted={() => { void refresh(); closeConsent(true); }}
      />
    </div>
  );
}


// ─── Home canvas ──────────────────────────────────────────────────────────────

function HomeCanvas({ onDomain, onOther, doneIds }: {
  onDomain:(id:DomainId)=>void;
  onOther:()=>void;
  doneIds: Set<string>;
}) {
  const { user } = useAuth();
  const firstName = (user?.user_metadata?.name || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "there").split(" ")[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  const { items: inboxRaw, error: inboxErr } = useInbox();
  const inbox = useMemo(() => (inboxRaw ?? []).filter(i => !doneIds.has(i.id)), [inboxRaw, doneIds]);

  // Manual tasks the user added via the header "Add task" button. Stored in
  // localStorage; merged here so they appear in the matching bento box
  // alongside live Gmail items.
  const { tasks: manualTasks } = useManualTasks();
  const activeManual = useMemo(() => manualTasks.filter(t => !t.done), [manualTasks]);

  const liveByDomain = useMemo(() => {
    const groups: Partial<Record<DomainId, Array<{ id:string; text:string; meta:string; urgent:boolean; progress:number }>>> = {};
    // Manual tasks first so they appear at the top of each domain.
    activeManual.forEach(t => {
      const arr = groups[t.domain] ?? (groups[t.domain] = []);
      arr.push({ id: t.id, text: t.text, meta: "Added by you", urgent: t.urgent, progress: 0 });
    });
    (inbox ?? []).filter(i => i.category !== "ignore" && i.category !== "needs_review").forEach(i => {
      const arr = groups[i.domain] ?? (groups[i.domain] = []);
      arr.push({
        id: i.id,
        text: i.subject,
        meta: i.from || i.reason || "",
        urgent: i.category === "urgent",
        progress: 0,
      });
    });
    return groups;
  }, [inbox, activeManual]);

  const urgencyByDomain = useMemo(() => {
    const out: Partial<Record<DomainId, UrgencyCounts>> = {};
    (inbox ?? []).forEach(i => {
      if (i.category === "ignore" || i.category === "needs_review") return;
      const u = out[i.domain] ?? (out[i.domain] = { urgent: 0, today: 0, proactive: 0 });
      if (i.category === "urgent") u.urgent += 1;
      else if (i.category === "today") u.today += 1;
      else if (i.category === "proactive") u.proactive += 1;
    });
    // Manual tasks bump urgent vs proactive depending on the urgency hint.
    activeManual.forEach(t => {
      const u = out[t.domain] ?? (out[t.domain] = { urgent: 0, today: 0, proactive: 0 });
      if (t.urgent) u.urgent += 1;
      else u.proactive += 1;
    });
    return out;
  }, [inbox, activeManual]);

  const otherList = useMemo(
    () => (inbox ?? []).filter(i => i.category === "needs_review" || i.category === "ignore"),
    [inbox]
  );
  const otherCount = otherList.length;
  const totalUrgent = useMemo(
    () => (inbox ?? []).filter(i => i.category === "urgent").length,
    [inbox]
  );

  // Build a unified tile list (5 domains + Other) and rank by weight.
  // Weight: urgent*4 + today*2 + proactive*1 + total*0.25 (ties → static activity).
  type Tile =
    | { kind: "domain"; id: DomainId; weight: number; count: number }
    | { kind: "other";  weight: number; count: number };

  // Pinned tile (hybrid: pin always takes xl slot, rest auto-rank)
  const [pinnedKey, setPinnedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("nc.pinnedTile");
  });
  const togglePin = useCallback((key: string) => {
    setPinnedKey(prev => {
      const next = prev === key ? null : key;
      try {
        if (next) window.localStorage.setItem("nc.pinnedTile", next);
        else window.localStorage.removeItem("nc.pinnedTile");
      } catch {}
      return next;
    });
  }, []);

  const tiles = useMemo<Tile[]>(() => {
    const domainTiles: Tile[] = (Object.values(DOMAINS) as DomainData[]).map(d => {
      const u = urgencyByDomain[d.id] ?? { urgent: 0, today: 0, proactive: 0 };
      const count = liveByDomain[d.id]?.length ?? 0;
      const weight = u.urgent * 4 + u.today * 2 + u.proactive + count * 0.25 + d.activity * 0.05;
      return { kind: "domain", id: d.id, weight, count };
    });
    const otherWeight = otherCount * 0.6;
    const otherTile: Tile = { kind: "other", weight: otherWeight, count: otherCount };
    const all = [...domainTiles, otherTile].sort((a, b) => b.weight - a.weight);
    if (!pinnedKey) return all;
    const idx = all.findIndex(t => (t.kind === "domain" ? t.id : "other") === pinnedKey);
    if (idx <= 0) return all;
    const [pinned] = all.splice(idx, 1);
    return [pinned, ...all];
  }, [liveByDomain, urgencyByDomain, otherCount, pinnedKey]);

  const slots = ["xl", "md", "md", "sm", "sm", "sm"] as const;

  // Brief: the single thing that should be on the user's mind right now.
  // Walk the already-ranked tiles and return the *first item with actual
  // content*. Prefers urgent items in the top tile when present. Falls back
  // to the DOMAINS fixture data when no live data is loaded (e.g. Gmail not
  // yet connected) so the surface stays demonstrable. Mobile shows this
  // prominently; desktop still gets the original pill.
  const briefText = useMemo<string>(() => {
    for (const tile of tiles) {
      if (tile.kind === "domain") {
        const live = liveByDomain[tile.id];
        if (live && live.length > 0) {
          // Prefer the first urgent item if any exist in the top tile.
          const urgent = live.find(i => i.urgent);
          return (urgent ?? live[0]).text;
        }
        // Fixture fallback so the Brief reads meaningful when nothing real
        // is pending (e.g. before the user connects Gmail).
        const fx = DOMAINS[tile.id].items;
        if (fx && fx.length > 0) {
          const urgent = fx.find(i => i.urgent);
          return (urgent ?? fx[0]).text;
        }
      } else if (tile.kind === "other" && otherList.length > 0) {
        return otherList[0].subject;
      }
    }
    return "Nothing pending. Want to plan tomorrow?";
  }, [tiles, liveByDomain, otherList]);

  return (
    // pb-28 leaves room for the fixed MobileQuickBar on mobile; md:pb-3 reverts.
    // pt-[env(safe-area-inset-top)] keeps the Brief card clear of the iOS notch
    // when the TopBar is hidden on mobile (desktop has its own sticky wrapper).
    <div className="flex flex-col p-3 lg:p-4 gap-3 pb-28 md:pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] md:pt-3">
      {/* Mobile-only Brief card. Larger and more prominent than the desktop
          greeting pill — this is the "one thing right now" that the personal-OS
          framing depends on. */}
      <div className="md:hidden flex-shrink-0 flex flex-col gap-2 px-4 py-3.5 rounded-2xl border border-border"
        style={{background:"radial-gradient(ellipse at 0% 50%,rgba(139,92,246,0.10) 0%,transparent 60%),var(--surface-elevated)"}}>
        <div className="flex items-center justify-between text-[10.5px] font-mono">
          <span className="text-muted-foreground">{greet}, {firstName}</span>
          <span className="text-muted-foreground">{dateLabel}</span>
        </div>
        <p className="text-[15px] font-medium text-foreground/95 leading-snug" style={{fontFamily:"var(--font-display)"}}>
          {briefText}
        </p>
        {totalUrgent > 0 && (
          <span className="self-start inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold border"
            style={{background:"rgba(248,113,113,0.16)", borderColor:"rgba(248,113,113,0.4)", color:"#fca5a5"}}>
            <span className="w-1 h-1 rounded-full bg-rose-300"/>
            {totalUrgent} urgent
          </span>
        )}
      </div>

      {/* Desktop pill: original compact format — greeting + urgent count + date. */}
      <div className="hidden md:flex flex-shrink-0 items-center gap-3 px-4 py-2.5 rounded-2xl border border-border"
        style={{background:"radial-gradient(ellipse at 0% 50%,rgba(139,92,246,0.06) 0%,transparent 60%),var(--surface-elevated)"}}>
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:"#9b6dfa",boxShadow:"0 0 8px rgba(155,109,250,0.7)"}}/>
        <span className="flex-1 text-[13px] text-foreground/80 font-medium truncate" style={{fontFamily:"var(--font-display)"}}>
          {greet}, {firstName}
        </span>
        {totalUrgent > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold border flex-shrink-0"
            style={{background:"rgba(248,113,113,0.16)", borderColor:"rgba(248,113,113,0.4)", color:"#fca5a5", boxShadow:"0 0 6px rgba(248,113,113,0.45)"}}>
            <span className="w-1 h-1 rounded-full bg-rose-300"/>
            {totalUrgent} urgent
          </span>
        )}
        <span className="text-[10.5px] text-muted-foreground font-mono">{dateLabel}</span>
      </div>

      {/* Domain tiles — moved here from the header so they sit right under the
          greeting, giving the bento entry-points more visual weight. */}
      <div className="flex-shrink-0 flex justify-center md:justify-start px-1">
        <DomainTiles onDomain={onDomain}/>
      </div>

      {inboxErr && (
        <div className="flex-shrink-0 rounded-2xl border border-rose-400/20 bg-rose-500/[0.04] px-4 py-2.5">
          <p className="text-[11.5px] text-social/80">Couldn't load inbox: {inboxErr} · <Link to="/workspace/connections" className="text-success/80 hover:text-success font-mono">connect Gmail →</Link></p>
        </div>
      )}

      <div className="flex-shrink-0 md:overflow-x-auto">
        {/* Bento layout. Responsive rules live in src/styles.css under `.nc-bento-grid`
            (Tailwind arbitrary value couldn't express grid-template-areas with quoted
            strings, hence the CSS class).
            Mobile (< md): grid-cols-1 utility → children stack vertically; children's
            inline `gridArea: s${i}` falls back to auto since no areas are defined.
            md+: `.nc-bento-grid` defines a 3-column bento with named areas s0..s5,
            so children's inline gridArea snaps them into the bento positions. */}
        <motion.div layout className="nc-bento-grid min-h-[420px] grid gap-2.5 grid-cols-1">
          <AnimatePresence initial={false}>
            {tiles.slice(0, 6).map((tile, i) => {
              const size = slots[i];
              const key = tile.kind === "domain" ? tile.id : "other";
              return (
                <motion.div
                  key={key}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.8 }}
                  style={{gridArea:`s${i}`, minWidth: 0}}
                >
                  {tile.kind === "domain" ? (
                    <DomainCard
                      domain={DOMAINS[tile.id]}
                      size={size}
                      onClick={() => onDomain(tile.id)}
                      liveItems={liveByDomain[tile.id]}
                      liveCount={liveByDomain[tile.id]?.length}
                      urgency={urgencyByDomain[tile.id]}
                      pinned={pinnedKey === tile.id}
                      onTogglePin={() => togglePin(tile.id)}
                    />
                  ) : (
                    <OtherCard
                      size={size}
                      count={tile.count}
                      items={otherList}
                      onClick={onOther}
                      pinned={pinnedKey === "other"}
                      onTogglePin={() => togglePin("other")}
                    />
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Other tile (size-aware) ──────────────────────────────────────────────────

function OtherCard({ size, count, items, onClick, pinned, onTogglePin }: {
  size: "xl"|"md"|"sm"; count: number; items: InboxItem[]; onClick: () => void;
  pinned?: boolean; onTogglePin?: () => void;
}) {
  const isXL = size === "xl";
  const isSM = size === "sm";
  const maxItems = isXL ? 4 : size === "md" ? 2 : 1;
  const preview = items.slice(0, maxItems);
  return (
    <button onClick={onClick}
      className={`group relative w-full h-full rounded-2xl border border-border cursor-pointer overflow-hidden hover:border-border hover:brightness-110 transition-all text-left flex ${isSM ? "items-center gap-3 px-4" : "flex-col p-4 gap-3"}`}
      style={{background:"radial-gradient(ellipse at 0% 0%,rgba(255,255,255,0.05) 0%,transparent 60%),var(--surface-elevated)"}}>
      {onTogglePin && (
        <span
          role="button"
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          title={pinned ? "Unpin" : "Pin to top"}
          className={`absolute top-2 right-2 z-10 w-6 h-6 rounded-md flex items-center justify-center border transition-all after:content-[''] after:absolute after:-inset-2.5 after:md:hidden ${pinned ? "opacity-100 bg-primary/20 border-primary/40 text-success" : "opacity-0 group-hover:opacity-100 bg-muted border-border text-muted-foreground hover:text-foreground/80 hover:bg-muted"}`}>
          {pinned ? <PinOff size={11}/> : <Pin size={11}/>}
        </span>
      )}
      <div className={`flex items-center justify-between flex-shrink-0 ${isSM ? "" : "w-full"}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`${isXL ? "w-8 h-8" : "w-6 h-6"} rounded-lg flex items-center justify-center flex-shrink-0 bg-muted border border-border`}>
            <Inbox size={isXL ? 14 : 12} className="text-muted-foreground/80"/>
          </div>
          <span className={`${isXL ? "text-[13px]" : "text-[12px]"} font-semibold text-foreground/85 truncate`} style={{fontFamily:"var(--font-sans)"}}>Other</span>
        </div>
        {!isSM && count > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold border flex-shrink-0"
            style={{background:"rgba(255,255,255,0.05)", borderColor:"rgba(255,255,255,0.12)", color:"rgba(255,255,255,0.7)"}}>
            {count}
          </span>
        )}
      </div>

      {isSM ? (
        <div className="flex-1 min-w-0">
          {preview[0] ? (
            <p className="text-[11px] text-foreground/75 truncate" style={{fontFamily:"var(--font-sans)"}}>{preview[0].subject}</p>
          ) : (
            <p className="text-[9.5px] text-muted-foreground truncate font-mono">nothing pending</p>
          )}
          {count > 1 && (
            <p className="text-[9px] text-muted-foreground truncate font-mono">+{count - 1} more</p>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-1.5 min-h-0 overflow-hidden w-full">
          {preview.length === 0 ? (
            <p className="text-[10.5px] text-muted-foreground font-mono">Nothing uncategorized</p>
          ) : (
            preview.map(item => (
              <div key={item.id} className="flex items-start gap-2.5 min-w-0">
                <span className="mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0 bg-muted-foreground/40"/>
                <div className="flex-1 min-w-0">
                  <p className="text-[11.5px] text-foreground/80 leading-snug truncate" style={{fontFamily:"var(--font-sans)"}}>{item.subject}</p>
                  {isXL && <p className="text-[10px] text-muted-foreground truncate">{item.from}</p>}
                </div>
              </div>
            ))
          )}
          {count > preview.length && (
            <p className="text-[9.5px] text-muted-foreground font-mono mt-auto">+{count - preview.length} more</p>
          )}
        </div>
      )}

      {!isSM && (
        <div className="flex-shrink-0 flex items-center justify-end pt-2 border-t border-border w-full">
          <ArrowRight size={11} className="text-muted-foreground group-hover:text-muted-foreground transition-colors"/>
        </div>
      )}
    </button>
  );
}

// ─── Domain detail (full-screen sheet) ────────────────────────────────────────

function DomainDetail({ domainId, onClose, onCompose, doneIds, onResolve, onUnresolve }: {
  domainId: DomainId | "other";
  onClose: () => void;
  onCompose: () => void;
  doneIds: Set<string>;
  onResolve: (id: string) => void;
  onUnresolve: (id: string) => void;
}) {
  const isOther = domainId === "other";
  const domain = isOther ? null : DOMAINS[domainId];
  const c = isOther ? null : C[domainId];
  const Icon = domain?.Icon;

  const { items: inbox, error: inboxErr } = useInbox();
  const { tasks: manualTasks, toggleDone: toggleManualDone, removeTask: removeManualTask } = useManualTasks();
  const { status, refresh } = useVoiceDraftsStatus();
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const requestConsent = async (): Promise<boolean> => {
    setConsentOpen(true);
    return new Promise<boolean>((resolve) => { consentResolverRef.current = resolve; });
  };
  const closeConsent = (accepted: boolean) => {
    setConsentOpen(false);
    consentResolverRef.current?.(accepted);
    consentResolverRef.current = null;
  };

  const items = useMemo(() => {
    if (!inbox) return [];
    if (isOther) return inbox.filter(i => i.category === "needs_review" || i.category === "ignore");
    return inbox.filter(i => i.domain === domainId && i.category !== "ignore" && i.category !== "needs_review");
  }, [inbox, isOther, domainId]);

  const myManualTasks = useMemo(
    () => (isOther ? [] : manualTasks.filter(t => t.domain === domainId)),
    [manualTasks, isOther, domainId]
  );

  const visible = items.filter(i => !doneIds.has(i.id));
  const fallbackC = C.professional;
  const cardC = c ?? fallbackC;

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{background:"var(--surface-elevated)",backdropFilter:"blur(24px)"}}>
      {/* Header with prominent back button */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-background/70 backdrop-blur-md"
        style={{paddingTop:"max(env(safe-area-inset-top), 0.75rem)"}}>
        <button onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-muted text-foreground/85 hover:bg-muted hover:border-border transition-all flex-shrink-0">
          <ArrowLeft size={14}/>
          <span className="text-[12px] font-medium" style={{fontFamily:"var(--font-sans)"}}>Back</span>
        </button>
        {isOther ? (
          <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0 bg-muted border border-border">
            <Inbox size={13} className="text-muted-foreground/80"/>
          </div>
        ) : (
          <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{background:`linear-gradient(135deg,${cardC.tile},${cardC.tile})`,boxShadow:`0 1px 10px ${cardC.glow}`}}>
            {Icon && <Icon size={13} style={{color:cardC.icon}}/>}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-semibold text-foreground truncate" style={{fontFamily:"var(--font-display)"}}>
            {isOther ? "Other" : domain!.label}
          </p>
          <p className="text-[10px] font-mono text-muted-foreground">
            {visible.length + myManualTasks.length} {visible.length + myManualTasks.length === 1 ? "item" : "items"}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 scrollbar-none">
        <div className="max-w-2xl mx-auto flex flex-col gap-2">
          {inboxErr && (
            <div className="rounded-2xl border border-rose-400/20 bg-rose-500/[0.04] px-4 py-3">
              <p className="text-[11.5px] text-social/80">Couldn't load inbox: {inboxErr}</p>
            </div>
          )}
          {!inbox && !inboxErr && (
            <div className="rounded-2xl border border-border px-4 py-3 text-[11.5px] text-muted-foreground">Loading…</div>
          )}
          {myManualTasks.length > 0 && (
            <div className="rounded-2xl border border-border bg-muted p-2 flex flex-col gap-1">
              <div className="px-2 pt-1 pb-0.5 flex items-center justify-between">
                <Mono className="!text-foreground/55">Your tasks</Mono>
                <span className="text-[10px] font-mono text-muted-foreground">{myManualTasks.length}</span>
              </div>
              {myManualTasks.map(t => (
                <div key={t.id} className="group flex items-center gap-2 px-2 py-2 rounded-xl hover:bg-muted transition-colors">
                  <button
                    onClick={() => toggleManualDone(t.id)}
                    className="w-4 h-4 rounded-md border border-border flex items-center justify-center flex-shrink-0 hover:border-border transition-colors"
                    style={t.done ? { background: cardC.icon, borderColor: cardC.icon } : undefined}
                    aria-label={t.done ? "Mark not done" : "Mark done"}
                  >
                    {t.done && <Check size={10} className="text-background"/>}
                  </button>
                  <span className={`flex-1 text-[12.5px] leading-snug ${t.done ? "line-through text-muted-foreground" : "text-foreground/85"}`} style={{fontFamily:"var(--font-sans)"}}>
                    {t.text}
                  </span>
                  {t.urgent && !t.done && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-md bg-rose-500/15 text-social/90">urgent</span>
                  )}
                  <button
                    onClick={() => removeManualTask(t.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-social transition-all"
                    aria-label="Remove"
                  >
                    <X size={12}/>
                  </button>
                </div>
              ))}
            </div>
          )}
          {inbox && visible.length === 0 && myManualTasks.length === 0 && (
            <div className="rounded-2xl border border-border px-4 py-6 flex flex-col items-center gap-2 text-center">
              <Check size={16} className="text-personal"/>
              <p className="text-[12.5px] text-muted-foreground" style={{fontFamily:"var(--font-sans)"}}>
                {isOther ? "Nothing uncategorized" : "Nothing pending here"}
              </p>
            </div>
          )}
          {visible.map(item => {
            const s = CAT_STYLE[item.category];
            const draftable = item.category !== "ignore"
              && (status?.featureEnabled ?? true);
            return (
              <InboxRow
                key={item.id}
                item={item}
                c={cardC}
                s={s}
                consented={status?.consented ?? false}
                onRequestConsent={requestConsent}
                onCompose={onCompose}
                onMarkDone={() => {
                  onResolve(item.id);
                  import("@/lib/gmail.functions").then(({ markInboxItemDone }) =>
                    markInboxItemDone({ data: { id: item.id, action: "done" } })
                  ).catch((e) => {
                    console.error("markInboxItemDone failed:", e);
                    onUnresolve(item.id);
                  });
                }}
                draftable={draftable}
              />
            );
          })}

          {!isOther && domain?.connectionNote && (
            <div className="mt-3 rounded-xl border border-cyan-400/20 px-4 py-3"
              style={{background:"radial-gradient(ellipse at 0% 0%,rgba(6,182,212,0.08) 0%,transparent 65%)"}}>
              <div className="flex items-center gap-1.5 mb-1"><TrendingUp size={10} className="text-professional"/><Mono className="!text-professional/60">Cross-domain</Mono></div>
              <p className="text-[11.5px] text-foreground/65 leading-snug">{domain.connectionNote}</p>
            </div>
          )}
          {!isOther && domain && (
            <div className="mt-1 rounded-xl border border-border bg-muted px-4 py-3">
              <Mono className="block mb-2">Sources</Mono>
              <div className="flex flex-wrap gap-1.5">
                {domain.sources.map(s=>(
                  <span key={s} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-mono text-foreground/50 bg-muted border border-border">
                    <span className="w-1 h-1 rounded-full bg-emerald-400/80"/>
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConsentModal
        open={consentOpen}
        onClose={() => closeConsent(false)}
        onAccepted={() => { void refresh(); closeConsent(true); }}
      />
    </div>
  );
}

// ─── Mind map canvas ──────────────────────────────────────────────────────────

function MindMapCanvas() {
  const [hovered, setHovered] = useState<string|null>(null);
  return (
    <div className="flex-1 relative overflow-hidden p-4">
      <div className="absolute inset-4 rounded-2xl border border-border overflow-hidden"
        style={{background:"var(--surface-elevated)"}}>
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" style={{zIndex:1}}>
          {MIND_EDGES.map(edge=>{
            const from=MIND_NODES.find(n=>n.id===edge.from), to=MIND_NODES.find(n=>n.id===edge.to);
            if(!from||!to) return null;
            const active=hovered===edge.from||hovered===edge.to;
            return <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke={edge.cross?"#22d3ee":C[from.domainId].hex}
              strokeOpacity={active?0.65:edge.cross?0.22:0.12}
              strokeWidth={active?0.8:0.45}
              strokeDasharray={edge.cross?"1.5 1.5":"3 2"}/>;
          })}
        </svg>
        {MIND_NODES.map(node=>{
          const c=C[node.domainId], isSig=node.id==="sig", isHov=hovered===node.id;
          return (
            <div key={node.id} className="absolute z-10 -translate-x-1/2 -translate-y-1/2 cursor-pointer"
              style={{left:`${node.x}%`,top:`${node.y}%`}}
              onMouseEnter={()=>setHovered(node.id)} onMouseLeave={()=>setHovered(null)}>
              {isSig ? (
                <div className="px-3 py-1.5 rounded-xl border border-cyan-400/35 text-center transition-all"
                  style={{background:"rgba(6,182,212,0.08)",backdropFilter:"blur(8px)",boxShadow:isHov?"0 0 20px rgba(6,182,212,0.28)":"0 0 8px rgba(6,182,212,0.12)"}}>
                  <p className="text-[11px] font-semibold text-professional whitespace-nowrap" style={{fontFamily:"var(--font-sans)"}}>{node.label}</p>
                  <p className="text-[9px] text-professional/55 font-mono">{node.sub}</p>
                </div>
              ) : (
                <div className={`px-2.5 py-1.5 rounded-xl border transition-all max-w-[130px] ${c.border}`}
                  style={{background:isHov?c.tile:"var(--surface-elevated)",backdropFilter:"blur(6px)",boxShadow:isHov?`0 0 14px ${c.glow}`:undefined}}>
                  <p className={`text-[11px] font-medium ${isHov?c.text:"text-foreground/75"} whitespace-nowrap`} style={{fontFamily:"var(--font-sans)"}}>{node.label}</p>
                  <p className="text-[9px] text-muted-foreground font-mono mt-0.5">{node.sub}</p>
                </div>
              )}
            </div>
          );
        })}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 bg-foreground/30 rounded-xl px-2.5 py-2 backdrop-blur-sm">
          {DOMAIN_ORDER.map(id=>(
            <div key={id} className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{background:C[id].hex}}/>
              <span className="text-[8.5px] font-mono text-muted-foreground uppercase tracking-wider">{id.slice(0,5)}</span>
            </div>
          ))}
          <div className="border-t border-border pt-1 mt-0.5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400"/>
              <span className="text-[8.5px] font-mono text-muted-foreground uppercase tracking-wider">signal</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Memory canvas ────────────────────────────────────────────────────────────

const MEM_CATS: MemoryCategory[] = ["People","Projects","Preferences","Deadlines","Writing style","Recurring"];

function MemoryCanvas() {
  const [filter, setFilter] = useState<MemoryCategory|"all">("all");
  const [wrong, setWrong] = useState<string[]>([]);
  const visible = MEMORY_ITEMS.filter(m=>filter==="all"||m.category===filter);
  const grouped = MEM_CATS.reduce((acc,cat)=>{ const items=visible.filter(m=>m.category===cat); if(items.length) acc[cat]=items; return acc; },{} as Record<string,MemoryItem[]>);

  return (
    <div className="flex-1 grid grid-cols-[180px_1fr] overflow-hidden">
      <aside className="border-r border-border p-3 flex flex-col gap-0.5 overflow-y-auto scrollbar-none">
        <Mono className="block px-2 mb-2">Memory</Mono>
        {(["all",...MEM_CATS] as ("all"|MemoryCategory)[]).map(cat=>{
          const count = cat==="all"?MEMORY_ITEMS.length:MEMORY_ITEMS.filter(m=>m.category===cat).length;
          return (
            <button key={cat} onClick={()=>setFilter(cat)}
              className={`w-full text-left px-3 py-2 rounded-xl text-[11.5px] transition-all border flex items-center gap-2 ${filter===cat?"bg-primary/10 border-primary/25 text-success":"border-transparent text-muted-foreground hover:text-foreground hover:bg-muted"}`}
              style={{fontFamily:"var(--font-sans)"}}>
              {cat!=="all" && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${CAT_DOT[cat as MemoryCategory]}`}/>}
              <span className="flex-1 truncate">{cat==="all"?"All beliefs":cat}</span>
              <span className="text-[10px] opacity-35">{count}</span>
            </button>
          );
        })}
      </aside>
      <div className="overflow-y-auto p-5 flex flex-col gap-5 scrollbar-none">
        {Object.entries(grouped).map(([cat,items])=>(
          <div key={cat}>
            <div className="flex items-center gap-2 mb-2.5">
              <span className={`w-1.5 h-1.5 rounded-full ${CAT_DOT[cat as MemoryCategory]}`}/>
              <Mono>{cat}</Mono>
            </div>
            <div className="flex flex-col gap-1.5">
              {items.map(item=>{
                const isWrong=wrong.includes(item.id);
                return (
                  <div key={item.id} className={`group rounded-xl border px-4 py-3 transition-all ${isWrong?"border-red-500/20 bg-red-500/[0.03] opacity-50":"border-border bg-muted hover:border-border"}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {item.inferred && <span className="text-[8.5px] font-mono px-1.5 py-px rounded border text-success/80 bg-primary/10 border-primary/20">Inferred</span>}
                          {isWrong && <span className="text-[8.5px] font-mono px-1.5 py-px rounded border text-red-300 bg-red-500/10 border-red-500/20">Marked wrong</span>}
                        </div>
                        <p className="text-[12.5px] text-foreground/85 leading-snug" style={{fontFamily:"var(--font-sans)"}}>{item.belief}</p>
                        <p className="text-[10px] font-mono text-muted-foreground mt-1.5">{item.source} · Used {item.lastUsed}</p>
                      </div>
                      <span className={`flex-shrink-0 px-1.5 py-px rounded-full text-[8.5px] font-mono border ${CONF[item.confidence]}`}>{item.confidence}</span>
                    </div>
                    <div className="flex gap-1 mt-2.5 pt-2.5 border-t border-border opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="px-2 py-1 rounded-lg text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-all">Edit</button>
                      <button onClick={()=>setWrong(w=>w.includes(item.id)?w.filter(x=>x!==item.id):[...w,item.id])} className="px-2 py-1 rounded-lg text-[10px] font-mono text-muted-foreground hover:text-family hover:bg-amber-500/[0.08] transition-all">{isWrong?"Undo":"Mark wrong"}</button>
                      <button className="px-2 py-1 rounded-lg text-[10px] font-mono text-muted-foreground hover:text-red-400 hover:bg-red-500/[0.08] transition-all">Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Signals canvas ───────────────────────────────────────────────────────────

function SignalsCanvas() {
  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-none">
      <div className="max-w-xl mx-auto flex flex-col gap-4">
        <div className="mb-1">
          <p className="text-[20px] font-semibold text-foreground" style={{fontFamily:"var(--font-display)"}}>Emerging signals</p>
          <p className="text-[12.5px] text-muted-foreground mt-0.5" style={{fontFamily:"var(--font-sans)"}}>Clusters forming across your life before you notice them.</p>
        </div>
        {SIGNALS.map(signal=>{
          const mc=signal.momentum==="rising"?"text-personal bg-emerald-500/10 border-emerald-500/20":signal.momentum==="fading"?"text-red-300 bg-red-500/10 border-red-500/20":"text-family bg-amber-500/10 border-amber-500/20";
          return (
            <div key={signal.id} className="rounded-2xl border border-border bg-card/60 p-5">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className={`px-2 py-px rounded-full text-[9px] font-mono border ${mc}`}>{signal.momentum}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{signal.evidenceCount} signals</span>
                <div className="flex gap-1 ml-1">
                  {signal.domains.map(d=><span key={d} className="w-2 h-2 rounded-full" style={{background:C[d].hex+"cc"}} title={d}/>)}
                </div>
              </div>
              <p className="text-[13.5px] font-semibold text-foreground/90 mb-1.5" style={{fontFamily:"var(--font-sans)"}}>{signal.title}</p>
              <p className="text-[12px] text-muted-foreground leading-relaxed mb-4" style={{fontFamily:"var(--font-sans)"}}>{signal.summary}</p>
              <div className="flex items-center gap-2 pt-3 border-t border-border">
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11.5px] font-medium bg-primary/15 border border-primary/30 text-success hover:bg-primary/20 transition-all" style={{fontFamily:"var(--font-sans)"}}>
                  <ArrowRight size={10}/> {signal.suggestedAction}
                </button>
                <button className="px-3 py-1.5 rounded-xl text-[11.5px] text-muted-foreground border border-border hover:border-border hover:text-foreground transition-all ml-auto">Dismiss</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chat tool panel ──────────────────────────────────────────────────────────

const AI_MODELS: { id: AIModel; label: string; icon: LucideIcon; color: string }[] = [
  { id:"flash",   label:"FLASH",   icon:Zap,          color:"text-success bg-primary/15 border-primary/30" },
  { id:"pro",     label:"PRO",     icon:Brain,         color:"text-foreground/70 bg-muted border-border"  },
  { id:"genius",  label:"Genius",  icon:TrendingUp,    color:"text-foreground/70 bg-muted border-border"  },
  { id:"private", label:"PRIVATE", icon:Shield,        color:"text-foreground/70 bg-muted border-border"  },
];

type LiveChatMsg = {
  role: "user" | "assistant";
  text: string;
  /** Local preview URLs for image attachments (user messages only). */
  images?: string[];
  /** Routing breadcrumb shown under assistant messages. */
  meta?: { provider: string | null; model: string | null; fallbackDepth: number | null };
  /** Personalization context the broker injected for this turn (D8 Day 5). */
  contextUsed?: { categories: string[]; trait_paths: string[] } | null;
  /** On-device PRIVATE: WebLLM model-load progress in [0,100]. Cleared
   *  when the first real delta arrives. Never persisted to the DB. */
  loadProgressPct?: number | null;
  /** Web search results — when present, the assistant message renders as a
   *  structured list (title / url / snippet) instead of plain text. Comes
   *  from SearXNG via webSearch; client-only, not persisted to the DB. */
  searchResults?: Array<{ title: string; url: string; snippet: string; engine?: string }>;
  /** SearXNG instance the results came from — rendered as a "via …" footer. */
  searchInstance?: string | null;
  /** The original query (used for click-logging and as the human-readable
   *  caption above the results list). */
  searchQuery?: string;
};

function ChatPanel({ open, onClose, onSwitchToCompose }: { open:boolean; onClose:()=>void; onSwitchToCompose?:()=>void }) {
  const { addTask } = useManualTasks();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Separate ref for the camera-capture file input on web. Uses the
  // `capture="environment"` attribute so mobile browsers open the rear camera
  // directly. On native (Capacitor) we go through @capacitor/camera instead
  // for a richer permission flow + retake UI.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Input mode — drives placeholder + send dispatch. Set by the intent chips
  // in the empty state (Search / Task). Reverts to "chat" after a successful
  // send for those modes.
  const [inputMode, setInputMode] = useState<"chat" | "search" | "task">("chat");
  // SearXNG bindings for in-thread search results.
  const runWebSearch = useServerFn(webSearch);
  const logSearchClick = useServerFn(logOpenedSearchUrl);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    setAttachments(prev => {
      const next = [...prev];
      for (const f of arr) {
        if (next.length >= MAX_FILES_PER_MESSAGE) {
          void import("sonner").then(({ toast }) =>
            toast.error(`Max ${MAX_FILES_PER_MESSAGE} images per message`),
          );
          break;
        }
        const err = validateImage(f);
        if (err) {
          void import("sonner").then(({ toast }) => toast.error(err));
          continue;
        }
        next.push(makePending(f));
      }
      return next;
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const target = prev.find(p => p.id === id);
      if (target) revokePending(target);
      return prev.filter(p => p.id !== id);
    });
  }, []);

  // Camera capture — adds a photo from the device camera as a chat attachment.
  // Native (Capacitor): @capacitor/camera getPhoto for a real permission flow
  // and retake UI. The plugin handles iOS/Android permission prompts.
  // Web: fall back to a hidden <input capture="environment"> which mobile
  // Safari/Chrome handle by opening the camera directly. Desktop browsers
  // open a file picker — acceptable degradation; desktop users have the
  // existing paperclip path anyway.
  const handleCameraCapture = useCallback(async () => {
    const { Capacitor } = await import("@capacitor/core");
    if (Capacitor.isNativePlatform()) {
      try {
        const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
        const photo = await Camera.getPhoto({
          quality: 85,
          allowEditing: false,
          resultType: CameraResultType.Uri,
          source: CameraSource.Camera,
          saveToGallery: false,
          // Default to rear camera; Capacitor lets the user toggle within the
          // native UI before capture.
        });
        if (!photo.webPath) return;
        const res = await fetch(photo.webPath);
        const blob = await res.blob();
        const ext = (photo.format || "jpeg").replace(/^\./, "");
        const file = new File([blob], `camera-${Date.now()}.${ext}`, {
          type: blob.type || `image/${ext}`,
        });
        addFiles([file]);
      } catch (err: unknown) {
        // User cancelled the camera UI → silently no-op. Other errors:
        // surface via toast so it doesn't fail silently.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/cancelled|denied|user/i.test(msg)) {
          void import("sonner").then(({ toast }) => toast.error(`Camera: ${msg}`));
        }
      }
    } else {
      // Web fallback — click the hidden input with capture attribute.
      cameraInputRef.current?.click();
    }
  }, [addFiles]);

  // Cleanup object URLs on unmount
  useEffect(() => () => {
    attachments.forEach(revokePending);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [model, setModel] = useState<AIModel>("flash");
  // Private by default: hosted badges are locked until "Cloud chat" is on.
  const cloud = useCloudConsent();
  const cloudChatOn = cloud.isOn("cloud_chat");
  useEffect(() => {
    if (cloud.features && !cloudChatOn) setModel("private");
  }, [cloud.features, cloudChatOn]);
  const [messages, setMessages] = useState<LiveChatMsg[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Click-to-expand lightbox source. Cleared on backdrop click / Escape. */
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!lightboxSrc) return;
    // Capture-phase + stopImmediatePropagation so Escape closes the lightbox
    // FIRST without also tripping the panel-level Escape-to-close handler
    // registered in the effect below.
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setLightboxSrc(null);
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [lightboxSrc]);
  // Unified Converse surface: text vs voice modes share the same message list
  // and stream pipeline. Voice mode auto-plays the assistant reply via the
  // proxied ElevenLabs endpoint (skipped for PRIVATE badge per spec §3).
  const [mode, setMode] = useState<"text" | "voice">("text");
  const [lastLlmProvider, setLastLlmProvider] = useState<string | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceBadge = AI_MODEL_TO_BADGE[model];
  const preferLocal = readPreferLocalAudio();
  const triple = useMemo(
    () => buildTriple(voiceBadge, preferLocal, lastLlmProvider),
    [voiceBadge, preferLocal, lastLlmProvider],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(()=>{ if(open) setTimeout(()=>inputRef.current?.focus(),80); },[open]);
  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{ if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  // Keyboard-aware height via VisualViewport API.
  // 100dvh is unreliable in Capacitor WKWebView — the unit doesn't always
  // shrink when the iOS keyboard appears, so the chat header gets pushed
  // above the viewport when an input is focused. VisualViewport.height is
  // the *visible* viewport (excludes keyboard), supported iOS Safari/WKWebView
  // 13+. We mirror it into a CSS variable `--chat-h` that the outer panel
  // binds to. Cleanup on close so the variable doesn't leak to other surfaces.
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty("--chat-h", `${vv.height}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--chat-h");
    };
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  // Mirror `sending` into a ref so callers (ConverseInput via sendVoiceMessage)
  // can detect a stale closure and react synchronously instead of silently
  // early-returning. Without this, a turn fired from ConverseInput while the
  // keyboard path is still streaming would clear ConverseInput's local text
  // and resolve as a no-op — the input would vanish without ever being sent.
  const sendingRef = useRef(false);
  useEffect(() => { sendingRef.current = sending; }, [sending]);

  const runChatTurn = useCallback(async (
    text: string,
    pending: PendingAttachment[] = [],
  ): Promise<{ provider: string | null; text: string }> => {
    if (!text && pending.length === 0) return { provider: null, text: "" };
    if (sendingRef.current) {
      throw new Error("BUSY");
    }
    setError(null);
    if (model !== "private" && !(await cloud.ensure("cloud_chat"))) {
      return { provider: null, text: "" };
    }
    setSending(true);

    // Upload attachments first so we can include their storage paths.
    let attachmentPaths: string[] = [];
    const previewUrls = pending.map(p => p.previewUrl);
    if (pending.length > 0) {
      setUploadingAttachments(true);
      try {
        attachmentPaths = await uploadAttachments(pending);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
        setSending(false);
        setUploadingAttachments(false);
        return { provider: null, text: "" };
      }
      setUploadingAttachments(false);
    }

    // Optimistic: append user msg + an empty assistant msg that we'll fill via deltas.
    setMessages(prev => [
      ...prev,
      { role: "user", text, images: previewUrls.length ? previewUrls : undefined },
      { role: "assistant", text: "" },
    ]);

    let gotAnyDelta = false;
    let errorMsg: string | null = null;
    let finalProvider: string | null = null;
    let assistantText = "";
    try {
      const { streamChatMessage } = await import("@/lib/chat-stream");
      // PRIVATE: earlier turns stay in this browser and are passed in here.
      const history = model === "private"
        ? messagesRef.current
            .filter((m) => m.text && !m.searchQuery)
            .slice(-19)
            .map((m) => ({ role: m.role, content: m.text }))
        : undefined;
      const stream = streamChatMessage({ threadId, content: text, badge: model, attachments: attachmentPaths, history });
      for await (const evt of stream) {
        if (evt.kind === "init") {
          setThreadId(evt.threadId);
        } else if (evt.kind === "meta") {
          finalProvider = evt.provider ?? finalProvider;
          setMessages(prev => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                meta: { provider: evt.provider, model: "", fallbackDepth: evt.fallbackDepth },
              };
            }
            return next;
          });
        } else if (evt.kind === "load_progress") {
          // On-device PRIVATE first-run download. Render as a separate
          // status indicator on the assistant bubble; do NOT append to
          // .text (which would persist into the message body).
          setMessages(prev => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, loadProgressPct: evt.pct };
            }
            return next;
          });
        } else if (evt.kind === "delta") {
          gotAnyDelta = true;
          assistantText += evt.text;
          setMessages(prev => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              // First real delta clears any load-progress indicator.
              next[next.length - 1] = {
                ...last,
                text: last.text + evt.text,
                loadProgressPct: null,
              };
            }
            return next;
          });
        } else if (evt.kind === "done") {
          finalProvider = evt.provider ?? finalProvider;
          setMessages(prev => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                meta: {
                  provider: evt.provider,
                  model: evt.model,
                  fallbackDepth: evt.fallbackDepth,
                },
                contextUsed: evt.contextUsed,
                ...(evt.assistantImages && evt.assistantImages.length > 0
                  ? { images: [...(last.images ?? []), ...evt.assistantImages] }
                  : {}),
              };
            }
            return next;
          });
        } else if (evt.kind === "error") {
          // Task #52: PRIVATE on-device image-gen NSFW block. The server-fn
          // already persisted a styled placeholder assistant row; mirror it
          // into the live thread by filling the optimistic assistant bubble
          // with the same placeholder string (which the existing
          // `isImageBlocked` branch styles as the amber ShieldAlert bubble),
          // and DO NOT roll back the user message. We mark `gotAnyDelta`
          // so the finally{} branch keeps the bubble in place, and we leave
          // `errorMsg` null so the red error banner doesn't also appear.
          if (evt.type === "image_blocked") {
            gotAnyDelta = true;
            setMessages(prev => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  text: IMAGE_BLOCKED_PLACEHOLDER_TEXT,
                  loadProgressPct: null,
                };
              }
              return next;
            });
            break;
          }
          errorMsg = evt.message;
          if (evt.type === "cloud_feature_off") {
            errorMsg = CLOUD_FEATURE_OFF_MESSAGE;
            void cloud.refresh();
          }
          // Friendly cap-exceeded toast (spec §1 line 351 / §A1 line 386).
          if (evt.type === "cap_exceeded") {
            const badgeLabel = (evt.badge ?? model).toString().toUpperCase();
            const used = typeof evt.used === "number" ? evt.used : null;
            const cap = typeof evt.cap === "number" ? evt.cap : null;
            const tail = used !== null && cap !== null ? ` (${used}/${cap} today).` : ".";
            void import("sonner").then(({ toast }) => {
              toast.error(`Daily ${badgeLabel} limit reached${tail}`, {
                description: "Try a different badge, or upgrade for higher caps.",
                duration: 6000,
              });
            });
          }
          break;
        }
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to send message";
    } finally {
      if (errorMsg) {
        setError(errorMsg);
        if (!gotAnyDelta) {
          // Roll back both the empty assistant placeholder and the user message
          // so they can edit + retry.
          setMessages(prev => prev.slice(0, -2));
          setInput(text);
        } else {
          // Partial reply landed; keep what was streamed but drop the empty
          // tail-case won't apply since gotAnyDelta=true means the assistant
          // message has content.
        }
      }
      setSending(false);
    }
    if (finalProvider) setLastLlmProvider(finalProvider);
    return { provider: finalProvider, text: assistantText };
  }, [threadId, model, cloud]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || sending) return;

    // Mode dispatch — Search and Task short-circuit the chat pipeline.
    if (inputMode === "search" && text && !cloud.isOn("web_search")) {
      void cloud.ensure("web_search").then((ok) => {
        if (ok) setTimeout(() => handleSendRef.current?.(), 0);
      });
      return;
    }
    if (inputMode === "search" && text) {
      // Push the query as a user message + a "Searching…" assistant
      // placeholder, then call SearXNG and replace the placeholder with the
      // structured result list. Client-only — not persisted to chat_messages
      // because search history doesn't belong in chat history.
      setInput("");
      setInputMode("chat");
      const userMsg: LiveChatMsg = { role: "user", text };
      const loadingMsg: LiveChatMsg = {
        role: "assistant",
        text: "Searching the web…",
        searchQuery: text,
      };
      setMessages(m => [...m, userMsg, loadingMsg]);
      void (async () => {
        try {
          const res = await runWebSearch({ data: { query: text } });
          setMessages(m => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.searchQuery === text) {
              next[next.length - 1] = {
                ...last,
                text: "", // hide "Searching…" once results land — render flips to the list
                searchResults: res.results.slice(0, 8),
                searchInstance: res.instance,
              };
            }
            return next;
          });
        } catch {
          setMessages(m => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.searchQuery === text) {
              next[next.length - 1] = {
                ...last,
                text: "Couldn't reach search providers. Try again in a moment.",
              };
            }
            return next;
          });
        }
      })();
      return;
    }
    if (inputMode === "task" && text) {
      const added = addTask(text);
      setInput("");
      setInputMode("chat");
      if (added) {
        void import("sonner").then(({ toast }) =>
          toast.success(`Added: ${added.text.slice(0, 60)}${added.text.length > 60 ? "…" : ""}`),
        );
      }
      return;
    }

    // Fail-closed for PRIVATE + attachments: refuse before the upload starts
    // so we don't leave orphan bytes in the chat-attachments bucket. The
    // server-side runner has the same guard (defense-in-depth); this one
    // is purely UX so the toast fires instantly without a network round-trip.
    if (model === "private" && attachments.length > 0) {
      void import("sonner").then(({ toast }) =>
        toast.error(
          "PRIVATE can't see images on this device. Switch to FLASH, PRO, or Genius to send this attachment.",
        ),
      );
      return;
    }
    const pending = attachments;
    setInput("");
    setAttachments([]);
    void runChatTurn(text, pending).catch(() => { /* keyboard path can't BUSY-race itself */ });
  }, [input, attachments, sending, model, runChatTurn, inputMode, addTask, runWebSearch, cloud]);
  const handleSendRef = useRef(handleSend);
  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

  // Unified Converse seam: voice turns stream into the same thread as the
  // keyboard input, then auto-play the assembled assistant text via the
  // proxied ElevenLabs endpoint. PRIVATE skips TTS (browser-speech + text-only
  // per spec §3 V2). We return the assembled text so ConverseInput could
  // surface it too if desired — the UI source of truth is still the message list.
  const sendVoiceMessage = useCallback<SendVoiceMessage>(async (text, badge) => {
    try {
      const { provider, text: replyText } = await runChatTurn(text);
      // Stop any in-flight TTS before kicking off a new one.
      ttsAudioRef.current?.pause();
      ttsAudioRef.current = null;
      if (replyText && badge !== "PRIVATE") {
        try {
          ttsAudioRef.current = await playAssistantTts(replyText, badge, cloud.isOn("voice_replies"));
        } catch {
          /* TTS is best-effort — text reply already rendered. */
        }
      }
      return { text: replyText, llmProvider: provider ?? undefined };
    } catch (e) {
      if (e instanceof Error && e.message === "BUSY") {
        void import("sonner").then(({ toast }) => {
          toast("Still finishing the previous reply — try again in a moment.");
        });
        return { text: "" };
      }
      throw e;
    }
  }, [runChatTurn, cloud]);

  if(!open) return null;

  return (
    // Mobile: full-screen — chat is a destination, not a transient sheet.
    // Matches iMessage / WhatsApp / ChatGPT / Claude on iOS.
    // Height: `--chat-h` is set by the VisualViewport useEffect above (the
    // *visible* viewport, excludes the iOS keyboard). Fallback to 100dvh for
    // browsers without VisualViewport (older iOS / non-iOS desktop).
    // Desktop (md+): centered modal — `md:h-auto` overrides height so the
    // inner panel's max-h-[85vh] takes over.
    <div className="fixed inset-x-0 top-0 h-[var(--chat-h,100dvh)] md:inset-0 md:h-auto z-[60] flex items-stretch md:items-center justify-center md:px-4"
      onClick={onClose}
      style={{background:"var(--scrim)",backdropFilter:"blur(16px)"}}>
      <div className={`w-full md:max-w-[520px] md:max-h-[85vh] md:rounded-3xl border overflow-hidden shadow-2xl flex flex-col relative ${isDragging ? "border-primary/60" : "border-border"}`}
        style={{background:"var(--surface-elevated)",boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(155,109,250,0.12)"}}
        onClick={e=>e.stopPropagation()}
        onDragOver={e => { e.preventDefault(); if (!isDragging) setIsDragging(true); }}
        onDragLeave={e => { e.preventDefault(); setIsDragging(false); }}
        onDrop={e => {
          e.preventDefault();
          setIsDragging(false);
          const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
          if (files.length) addFiles(files);
        }}>
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary/50 rounded-3xl pointer-events-none">
            <p className="text-[13px] font-mono text-success">Drop images to attach</p>
          </div>
        )}

        {/* Header. pt picks up the iOS status-bar inset on mobile full-screen;
            md:pt-4 restores the original padding for desktop's modal. */}
        <div className="flex items-center gap-2 px-5 pt-[max(env(safe-area-inset-top),1rem)] md:pt-4 pb-4 border-b border-border flex-shrink-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}>
            <MessageCircle size={11} style={{color:"var(--foreground)"}}/>
          </div>
          <span className="text-[13px] font-semibold text-foreground flex-1" style={{fontFamily:"var(--font-display)"}}>Chat</span>
          {mode === "voice" && (
            <StatusPill triple={triple} className="hidden sm:inline-flex" />
          )}
          <div className="flex items-center gap-1">
            {["Memory","Inbox","Calendar"].map(ctx=>(
              <span key={ctx} className="px-1.5 py-px rounded-md text-[8.5px] font-mono bg-primary/10 text-success/70 border border-primary/15">{ctx}</span>
            ))}
          </div>
          <button onClick={onClose} className="ml-2 text-muted-foreground hover:text-foreground transition-colors"><X size={14}/></button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 flex flex-col gap-4 scrollbar-none min-h-0">
          {messages.length === 0 && !sending && (
            <div className="flex-1 flex items-center justify-center text-center px-6">
              <div className="max-w-[320px] w-full">
                <div className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center"
                  style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}>
                  <Zap size={16} style={{color:"var(--foreground)"}}/>
                </div>
                <p className="text-[12.5px] text-muted-foreground leading-relaxed" style={{fontFamily:"var(--font-sans)"}}>
                  Ask anything, or pick an action below — Search, Add task, or Draft.
                </p>
              </div>
            </div>
          )}
          {messages.map((msg,i)=>{
            const isLast = i === messages.length - 1;
            const isStreamingPlaceholder = msg.role === "assistant" && isLast && sending && msg.text.length === 0;
            // Task #47: distinguish on-device-image-blocked turns from
            // successful assistant replies. Detection key is the exact
            // placeholder string written by `finalizeOnDeviceImageGenBlockedTurn`
            // (pinned by the leak suite via IMAGE_BLOCKED_PLACEHOLDER_TEXT).
            const isImageBlocked = msg.role === "assistant" && msg.text === IMAGE_BLOCKED_PLACEHOLDER_TEXT;
            // Task #55 — recover the original user prompt that triggered the
            // block so the "Try a different prompt" action can repopulate the
            // input. We walk backwards from the blocked assistant turn to the
            // nearest preceding user message; this works for both the live
            // flow (assistant immediately after the user) and historical rows
            // on reload (where the order is preserved by `loadThread`).
            let blockedPromptText = "";
            if (isImageBlocked) {
              for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === "user") {
                  blockedPromptText = messages[j].text ?? "";
                  break;
                }
              }
            }
            return (
            <div key={i} className={`flex ${msg.role==="user"?"justify-end":"justify-start"}`}>
              {msg.role==="assistant" ? (
                <div className="max-w-[92%]">
                  <div className="flex items-start gap-2">
                    <div
                      className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={isImageBlocked
                        ? {background:"linear-gradient(135deg,#b4530933,#7c2d1233)", border:"1px solid rgba(251,146,60,0.35)"}
                        : {background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}
                    >
                      {isImageBlocked
                        ? <ShieldAlert size={11} style={{color:"#fdba74"}} aria-hidden="true"/>
                        : <Zap size={10} style={{color:"var(--foreground)"}}/>}
                    </div>
                    <div
                      className={isImageBlocked
                        ? "rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-amber-500/30 bg-amber-500/[0.07] min-w-[140px]"
                        : "rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-border bg-card/80 min-w-[140px]"}
                      role={isImageBlocked ? "status" : undefined}
                      aria-label={isImageBlocked ? "Generated image was blocked by the on-device safety classifier" : undefined}
                    >
                      {typeof msg.loadProgressPct === "number" && msg.text.length === 0 ? (
                        <div className="flex flex-col gap-1.5 py-0.5" aria-label="Loading on-device model" role="status">
                          <p className="text-[11px] text-muted-foreground leading-snug" style={{fontFamily:"var(--font-sans)"}}>
                            Loading on-device model{msg.loadProgressPct < 100 ? ` — first run downloads ~700 MB` : ""}…
                          </p>
                          <div className="h-1 w-40 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full bg-primary/60 transition-[width] duration-200 ease-out"
                              style={{ width: `${Math.max(2, Math.min(100, msg.loadProgressPct))}%` }}
                            />
                          </div>
                          <p className="text-[10px] font-mono text-muted-foreground">{msg.loadProgressPct}%</p>
                        </div>
                      ) : isStreamingPlaceholder ? (
                        <div className="flex flex-col gap-1.5 py-0.5" aria-label="Assistant is responding" role="status">
                          <div className="h-2 w-32 rounded bg-muted animate-pulse"/>
                          <div className="h-2 w-24 rounded bg-muted animate-pulse" style={{animationDelay:"120ms"}}/>
                          <div className="h-2 w-20 rounded bg-muted animate-pulse" style={{animationDelay:"240ms"}}/>
                        </div>
                      ) : (
                        <>
                          {msg.images && msg.images.length > 0 && (
                            <div className="grid grid-cols-1 gap-1.5">
                              {msg.images.map((src, k) => (
                                <button
                                  type="button"
                                  key={k}
                                  onClick={() => setLightboxSrc(src)}
                                  className="block w-full rounded-lg overflow-hidden border border-border cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                                  aria-label="Expand generated image"
                                >
                                  <img src={src} alt="Generated image" className="max-h-80 object-contain w-full" />
                                </button>
                              ))}
                            </div>
                          )}
                          {msg.searchResults ? (
                            <div className="flex flex-col gap-2.5">
                              <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-muted-foreground">
                                <Search size={10} className="text-professional/70" />
                                <span>Search results</span>
                                {msg.searchInstance && (
                                  <span className="opacity-60">· via {(() => { try { return new URL(msg.searchInstance).host; } catch { return "searxng"; } })()}</span>
                                )}
                              </div>
                              {msg.searchResults.length === 0 ? (
                                <p className="text-[12.5px] text-muted-foreground" style={{fontFamily:"var(--font-sans)"}}>No results.</p>
                              ) : (
                                <ul className="flex flex-col gap-2">
                                  {msg.searchResults.map((h, k) => (
                                    <li key={k}>
                                      <a
                                        href={h.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() => {
                                          void logSearchClick({
                                            data: { query: msg.searchQuery ?? "", url: h.url },
                                          }).catch(() => {});
                                        }}
                                        className="block group rounded-lg p-2 -mx-2 hover:bg-muted transition-colors"
                                      >
                                        <div className="text-[13px] font-medium text-foreground/95 group-hover:text-success leading-snug" style={{fontFamily:"var(--font-sans)"}}>{h.title}</div>
                                        <div className="text-[10.5px] font-mono text-success/70 truncate mt-0.5">{h.url}</div>
                                        {h.snippet && (
                                          <div className="text-[11.5px] text-muted-foreground/75 leading-snug line-clamp-2 mt-0.5" style={{fontFamily:"var(--font-sans)"}}>{h.snippet}</div>
                                        )}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : msg.text && (
                            <p
                              className={isImageBlocked
                                ? "text-[12.5px] text-family/85 leading-relaxed whitespace-pre-wrap"
                                : "text-[12.5px] text-foreground/80 leading-relaxed whitespace-pre-wrap"}
                              style={{fontFamily:"var(--font-sans)"}}
                            >{msg.text}</p>
                          )}
                          {isImageBlocked && blockedPromptText && (
                            <button
                              type="button"
                              onClick={() => {
                                setInput(blockedPromptText);
                                // Defer focus a tick so the input has the new
                                // value before the cursor lands at the end.
                                setTimeout(() => {
                                  const el = inputRef.current;
                                  if (!el) return;
                                  el.focus();
                                  const len = blockedPromptText.length;
                                  try { el.setSelectionRange(len, len); } catch { /* non-text input */ }
                                }, 0);
                              }}
                              className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-family/90 bg-amber-500/[0.12] hover:bg-amber-500/20 border border-amber-500/30 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60"
                              aria-label={IMAGE_BLOCKED_RETRY_ACTION_LABEL}
                            >
                              <RotateCcw size={11} aria-hidden="true"/>
                              {IMAGE_BLOCKED_RETRY_ACTION_LABEL}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {msg.meta && (msg.meta.provider || msg.meta.model) && (
                    <div className="flex gap-1 mt-1.5 ml-8 flex-wrap">
                      <span className="text-[8.5px] font-mono text-muted-foreground px-1.5 py-px rounded-md bg-muted border border-border">
                        {msg.meta.provider}{msg.meta.model ? ` · ${msg.meta.model}` : ""}
                        {msg.meta.fallbackDepth && msg.meta.fallbackDepth > 0 ? ` · fallback ${msg.meta.fallbackDepth}` : ""}
                      </span>
                    </div>
                  )}
                  {msg.images && msg.images.length > 0 && msg.meta?.provider &&
                    (msg.meta.provider === "onDeviceWebGpuImage"
                      || msg.meta.provider === "onDeviceAppleImage"
                      || msg.meta.provider === "onDeviceAndroidImage") && (
                    <div className="ml-8 mt-1 flex items-center gap-1.5 text-[10px] font-mono text-personal/70">
                      <Shield size={9} />
                      <span>Generated on your device — no image bytes sent to any hosted provider.</span>
                    </div>
                  )}
                  {msg.contextUsed && msg.contextUsed.categories.length > 0 && (
                    <ContextFooter
                      contextUsed={msg.contextUsed as { categories: import("@/lib/trait-schema").TraitCategory[]; trait_paths: string[] }}
                      provider={msg.meta?.provider ?? null}
                    />
                  )}
                </div>
              ) : (
                <div className="rounded-2xl rounded-tr-sm px-3.5 py-2.5 bg-primary/15 border border-primary/20 max-w-[80%] flex flex-col gap-2">
                  {msg.images && msg.images.length > 0 && (
                    <div className="grid grid-cols-2 gap-1.5">
                      {msg.images.map((src, k) => (
                        <img key={k} src={src} alt="" className="rounded-lg max-h-40 object-cover w-full border border-border" />
                      ))}
                    </div>
                  )}
                  {msg.text && (
                    <p className="text-[12.5px] text-foreground/85 whitespace-pre-wrap" style={{fontFamily:"var(--font-sans)"}}>{msg.text}</p>
                  )}
                </div>
              )}
            </div>
          );
          })}
          {error && (
            <div className="flex justify-center">
              <div className="rounded-xl px-3 py-2 bg-red-500/10 border border-red-500/30 max-w-[90%]">
                <p className="text-[11.5px] text-red-300/90" style={{fontFamily:"var(--font-sans)"}}>{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Mode toggle + active input + model selector */}
        <div className="px-4 pt-4 pb-[max(env(safe-area-inset-bottom),1rem)] border-t border-border flex-shrink-0 flex flex-col gap-2.5">
          {/* Text ↔ Voice segmented control */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-muted border border-border self-start">
            {(["text","voice"] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`px-2.5 py-1 rounded-md text-[10px] font-mono tracking-wide transition-colors ${
                  mode === m
                    ? "bg-primary/20 text-success border border-primary/30"
                    : "text-muted-foreground hover:text-foreground/80"
                }`}
              >
                {m === "text" ? "Text" : "Voice"}
              </button>
            ))}
          </div>

          {/* Persistent intent chips — always visible during a chat session,
              not just in the empty state. Hidden when an action mode is
              already active (search / task pill takes their slot). Sets the
              mode + forces text-input over voice; Draft hands off to the
              ComposePanel (closes chat). */}
          {mode === "text" && inputMode === "chat" && (
            <div className="flex flex-wrap items-center gap-1.5 -mt-0.5">
              <button
                type="button"
                onClick={() => {
                  setInputMode("search");
                  setMode("text");
                  setTimeout(() => inputRef.current?.focus(), 60);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] text-foreground/75 border border-border bg-muted active:bg-muted transition-colors"
              >
                <Search size={10.5} className="text-professional/80" />
                Search
              </button>
              <button
                type="button"
                onClick={() => {
                  setInputMode("task");
                  setMode("text");
                  setTimeout(() => inputRef.current?.focus(), 60);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] text-foreground/75 border border-border bg-muted active:bg-muted transition-colors"
              >
                <Plus size={10.5} className="text-personal/80" />
                Task
              </button>
              {onSwitchToCompose && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onSwitchToCompose();
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] text-foreground/75 border border-border bg-muted active:bg-muted transition-colors"
                >
                  <PenLine size={10.5} className="text-social/80" />
                  Draft
                </button>
              )}
            </div>
          )}
          {mode === "text" ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted px-3 py-2.5">
              {/* Mode indicator — only shown when Search or Task mode is
                  active (set by the empty-state chips). Tapping X reverts to
                  chat. Visually a small pill with the mode's accent color. */}
              {inputMode !== "chat" && (
                <div className="flex items-center gap-1.5 -mt-0.5">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-mono border ${
                      inputMode === "search"
                        ? "border-sky-400/40 bg-sky-500/10 text-professional"
                        : "border-emerald-400/40 bg-emerald-500/10 text-personal"
                    }`}
                  >
                    {inputMode === "search" ? (
                      <><Search size={10} /> Search</>
                    ) : (
                      <><Plus size={10} /> Add task</>
                    )}
                    <button
                      type="button"
                      onClick={() => setInputMode("chat")}
                      aria-label="Cancel mode"
                      className="ml-0.5 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-muted transition-colors"
                    >
                      <X size={9} />
                    </button>
                  </span>
                </div>
              )}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {attachments.map(a => (
                    <div key={a.id} className="relative group">
                      <img src={a.previewUrl} alt="" className="h-12 w-12 rounded-md object-cover border border-border" />
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-background border border-border text-foreground/80 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground after:content-[''] after:absolute after:-inset-3.5 after:md:hidden"
                        aria-label="Remove image"
                      >
                        <X size={9}/>
                      </button>
                    </div>
                  ))}
                  {uploadingAttachments && (
                    <span className="text-[10px] font-mono text-muted-foreground self-center">uploading…</span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={e => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                {/* Web fallback for the camera button — `capture="environment"`
                    asks mobile browsers to open the rear camera directly.
                    Native uses @capacitor/camera; this input is only the
                    fallback path on web / desktop. */}
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={e => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending || attachments.length >= MAX_FILES_PER_MESSAGE}
                  className="relative w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed after:content-[''] after:absolute after:-inset-2 after:md:hidden"
                  aria-label="Attach image"
                  title="Attach image"
                >
                  <Paperclip size={13}/>
                </button>
                <button
                  type="button"
                  onClick={() => { void handleCameraCapture(); }}
                  disabled={sending || attachments.length >= MAX_FILES_PER_MESSAGE}
                  className="relative w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed after:content-[''] after:absolute after:-inset-2 after:md:hidden"
                  aria-label="Take photo with camera"
                  title="Take photo"
                >
                  <CameraIcon size={13}/>
                </button>
                <input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); handleSend(); } }}
                  onPaste={e => {
                    const files: File[] = [];
                    for (const item of Array.from(e.clipboardData.items)) {
                      if (item.kind === "file") {
                        const f = item.getAsFile();
                        if (f && f.type.startsWith("image/")) files.push(f);
                      }
                    }
                    if (files.length) {
                      e.preventDefault();
                      addFiles(files);
                    }
                  }}
                  disabled={sending}
                  placeholder={
                    sending ? "Sending…"
                    : attachments.length ? "Add a caption…"
                    : inputMode === "search" ? "Search the web for…"
                    : inputMode === "task" ? "Remind me to…"
                    : "Message your assistant…"
                  }
                  className="flex-1 bg-transparent text-[12.5px] text-foreground/75 placeholder:text-muted-foreground outline-none disabled:opacity-50"
                  style={{fontFamily:"var(--font-sans)"}}/>
                <button onClick={handleSend} disabled={sending || (!input.trim() && attachments.length === 0)}
                  className="relative w-7 h-7 rounded-lg flex items-center justify-center text-success hover:brightness-110 transition-all flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed after:content-[''] after:absolute after:-inset-2 after:md:hidden"
                  style={{background:"linear-gradient(135deg,rgba(109,40,217,0.35),rgba(76,29,149,0.2))"}}>
                  <Send size={11}/>
                </button>
              </div>
            </div>
          ) : (
            <div
              className={sending ? "pointer-events-none opacity-50" : ""}
              aria-busy={sending}
            >
              <Suspense fallback={<div className="h-16 rounded-lg bg-muted animate-pulse" />}>
                <ConverseInput
                  badge={voiceBadge}
                  sendVoiceMessage={sendVoiceMessage}
                />
              </Suspense>
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {AI_MODELS.map(m=>{
              const Icon=m.icon;
              const isActive=model===m.id;
              // Free-tier upsell on Genius (spec §A line 84-85: free = 0 Genius/day,
              // badge disabled, upsell shown). Paid-tier wiring lands with subscription
              // system; until then `getPaidTier` always returns false → all users free.
              const isLocked = m.id === "genius";
              if (isLocked) {
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-disabled="true"
                    title="Upgrade for Genius — the smartest model. Free tier: 0/day."
                    onClick={() => {
                      void import("sonner").then(({ toast }) => {
                        toast("Genius is for paid plans", {
                          description: "Upgrade to unlock the smartest model. Free tier gets FLASH, PRO, and on-device PRIVATE.",
                          duration: 5000,
                        });
                      });
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono tracking-wide border border-border bg-muted text-muted-foreground cursor-not-allowed relative"
                  >
                    <Icon size={9}/>
                    {m.label}
                    <Lock size={8} className="ml-0.5 opacity-60"/>
                  </button>
                );
              }
              if (m.id !== "private" && !cloudChatOn) {
                return (
                  <button
                    key={m.id}
                    type="button"
                    title="Turn on Cloud chat to use this model"
                    onClick={() => { void cloud.ensure("cloud_chat").then((ok) => { if (ok) setModel(m.id); }); }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono tracking-wide border border-border bg-muted text-muted-foreground"
                  >
                    <Icon size={9}/>
                    {m.label}
                    <Lock size={8} className="ml-0.5 opacity-60"/>
                  </button>
                );
              }
              return (
                <button key={m.id} onClick={()=>setModel(m.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono tracking-wide border transition-all ${isActive?m.color:"text-muted-foreground bg-transparent border-border hover:border-border hover:text-foreground/70"}`}>
                  <Icon size={9}/>
                  {m.label}
                </button>
              );
            })}
          </div>

        </div>
      </div>

      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-6 cursor-zoom-out"
          style={{ background: "var(--scrim)", backdropFilter: "blur(20px)" }}
          onClick={() => setLightboxSrc(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image"
        >
          <img
            src={lightboxSrc}
            alt="Expanded generated image"
            className="max-w-[92vw] max-h-[90vh] object-contain rounded-xl border border-border shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center bg-muted hover:bg-muted border border-border text-foreground/80 after:content-[''] after:absolute after:-inset-1 after:md:hidden"
            aria-label="Close expanded image"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Compose tool panel ───────────────────────────────────────────────────────

const CHANNELS: ComposeChannel[] = ["Email","Slack","WhatsApp","Doc","LinkedIn"];
const TONES:    ComposeTone[]    = ["Professional","Warm","Concise","Persuasive","Casual"];
const CONTEXT_CHIPS = ["Tone profile","Recent thread","Memory: Sarah Chen"];

function ComposePanel({ open, onClose }: { open:boolean; onClose:()=>void }) {
  const [channel, setChannel]   = useState<ComposeChannel>("Email");
  const [tone, setTone]         = useState<ComposeTone>("Professional");
  const [body, setBody]         = useState("");
  const [title, setTitle]       = useState("");
  const [ctx, setCtx]           = useState<string[]>(["Tone profile","Memory: Sarah Chen"]);

  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{ if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  if(!open) return null;

  const placeholder: Record<ComposeChannel,string> = {
    Email:"Hi Sarah,\n\nThank you for the updated terms…",
    Slack:"Hey @priya — quick update on the roadmap doc…",
    WhatsApp:"Hey Maya! So sorry for the delayed reply…",
    Doc:"# Q2 Roadmap Update\n\nKey milestones this quarter…",
    LinkedIn:"This week I went deep on AI agents. Three things surprised me…",
  };

  return (
    // Mobile: bottom sheet. Desktop (md+): centered modal.
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center md:px-4"
      onClick={onClose}
      style={{background:"var(--scrim)",backdropFilter:"blur(16px)"}}>
      <div className="w-full md:max-w-[540px] max-h-[90vh] md:max-h-[88vh] rounded-t-3xl md:rounded-3xl border border-border overflow-hidden shadow-2xl flex flex-col"
        style={{background:"var(--surface-elevated)",boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(155,109,250,0.12)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border flex-shrink-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}>
            <PenLine size={11} style={{color:"var(--foreground)"}}/>
          </div>
          <span className="text-[13px] font-semibold text-foreground flex-1" style={{fontFamily:"var(--font-display)"}}>Compose</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X size={14}/></button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3.5 border-b border-border flex flex-col gap-2.5 flex-shrink-0">
          <input value={title} onChange={e=>setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full bg-transparent text-[12.5px] text-foreground/80 placeholder:text-muted-foreground outline-none rounded-xl border border-border bg-muted px-3 py-2"
            style={{fontFamily:"var(--font-sans)"}}/>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Mono className="mr-1">Channel</Mono>
            {CHANNELS.map(ch=>(
              <button key={ch} onClick={()=>setChannel(ch)}
                className={`px-2.5 py-1 rounded-full text-[10.5px] border transition-all font-medium ${channel===ch?"text-foreground border-border bg-muted":"text-muted-foreground border-transparent hover:border-border hover:text-foreground"}`}
                style={{fontFamily:"var(--font-sans)"}}>
                {ch}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Mono className="mr-1">Tone</Mono>
            {TONES.map(t=>(
              <button key={t} onClick={()=>setTone(t)}
                className={`px-2.5 py-1 rounded-full text-[10.5px] border transition-all font-medium ${tone===t?"text-foreground border-border bg-muted":"text-muted-foreground border-transparent hover:border-border hover:text-foreground"}`}
                style={{fontFamily:"var(--font-sans)"}}>
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Mono className="mr-1">Context</Mono>
            {CONTEXT_CHIPS.map(chip=>{
              const active=ctx.includes(chip);
              return (
                <button key={chip} onClick={()=>setCtx(c=>c.includes(chip)?c.filter(x=>x!==chip):[...c,chip])}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] border transition-all ${active?"text-success border-primary/30 bg-primary/10":"text-muted-foreground border-transparent bg-muted hover:border-border"}`}
                  style={{fontFamily:"var(--font-sans)"}}>
                  <Zap size={8} className={active?"text-success":"text-muted-foreground"}/>
                  {chip}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 flex flex-col gap-3 overflow-hidden min-h-0">
          {(channel==="Email"||channel==="WhatsApp"||channel==="Slack") && (
            <div className="flex items-center gap-2 pb-2 border-b border-border">
              <Mono className="w-6 flex-shrink-0">To</Mono>
              <input placeholder={channel==="Email"?"sarah@a16z.com":channel==="WhatsApp"?"Maya":"@priya"}
                className="flex-1 bg-transparent text-[12px] text-foreground/75 placeholder:text-muted-foreground outline-none"
                style={{fontFamily:"var(--font-sans)"}}/>
            </div>
          )}
          <textarea value={body} onChange={e=>setBody(e.target.value)}
            placeholder={placeholder[channel]}
            rows={5}
            className="flex-1 bg-transparent text-[12.5px] text-foreground/75 placeholder:text-muted-foreground outline-none resize-none leading-relaxed scrollbar-none"
            style={{fontFamily:"var(--font-sans)"}}/>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex-shrink-0 flex items-center gap-2">
          <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[12.5px] font-semibold transition-all"
            style={{background:"linear-gradient(135deg,rgba(109,40,217,0.55),rgba(76,29,149,0.35))",border:"1px solid rgba(155,109,250,0.3)",color:"#ede9fe",fontFamily:"var(--font-sans)"}}>
            <Send size={12}/> Send
          </button>
          <button className="px-3.5 py-2.5 rounded-xl border border-border text-muted-foreground text-[11.5px] hover:text-foreground hover:border-border transition-all" style={{fontFamily:"var(--font-sans)"}}>Draft</button>
          <button onClick={onClose} className="px-3.5 py-2.5 rounded-xl text-muted-foreground text-[11.5px] hover:text-foreground transition-all" style={{fontFamily:"var(--font-sans)"}}>Discard</button>
        </div>
      </div>
    </div>
  );
}


// ─── Voice bar ───────────────────────────────────────────────────────────────

function VoiceBar({ open, onClose, onSubmitTask }: {
  open: boolean; onClose:()=>void; onSubmitTask:(text:string)=>void;
}) {
  const [mode, setMode]           = useState<VoiceMode>("quick");
  const [phase, setPhase]         = useState<"idle"|"listening"|"thinking"|"response">("idle");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse]   = useState("");
  const [demoIdx, setDemoIdx]     = useState(0);

  // Reset when closed
  useEffect(()=>{ if(!open){ setPhase("idle"); setTranscript(""); setResponse(""); } },[open]);

  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{ if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  const startListening = ()=>{
    const demo = VOICE_DEMOS.find(d=>d.mode===mode) ?? VOICE_DEMOS[0];
    setPhase("listening"); setTranscript(""); setResponse("");
    // Simulate transcription appearing character by character
    let i=0;
    const interval = setInterval(()=>{
      i++;
      setTranscript(demo.transcript.slice(0,i));
      if(i>=demo.transcript.length){ clearInterval(interval); setPhase("thinking");
        setTimeout(()=>{
          if(mode==="quick" && demo.quickResponse){
            setPhase("response"); setResponse(demo.quickResponse);
          } else {
            // Deep research — queue and close
            onSubmitTask(demo.transcript);
            onClose();
          }
        },1200);
      }
    },38);
  };

  if(!open) return null;

  const bars = [3,5,8,6,10,7,4,9,6,5,8,4,7,10,6,3,8,5,9,6];

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center px-4 pb-8 sm:pb-0"
      onClick={()=>{ if(phase==="idle"||phase==="response") onClose(); }}
      style={{background:"var(--scrim)",backdropFilter:"blur(16px)"}}>
      <div className="w-full max-w-[500px] rounded-3xl border border-border overflow-hidden shadow-2xl"
        style={{background:"var(--surface-elevated)",boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(155,109,250,0.12)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 p-4 pb-0">
          {([["quick","Quick answer"],["deep","Deep research"]] as [VoiceMode,string][]).map(([v,label])=>(
            <button key={v} onClick={()=>{ setMode(v); setPhase("idle"); setTranscript(""); setResponse(""); }}
              disabled={phase==="listening"||phase==="thinking"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-mono border transition-all ${mode===v
                ? v==="quick"?"text-professional bg-cyan-400/10 border-cyan-400/25":"text-success bg-primary/12 border-primary/30"
                : "text-muted-foreground border-transparent hover:border-border hover:text-muted-foreground"}`}>
              {v==="quick"?<Volume2 size={10}/>:<Moon size={10}/>}{label}
            </button>
          ))}
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground transition-colors"><X size={13}/></button>
        </div>

        {/* Main area */}
        <div className="px-6 py-6 flex flex-col items-center gap-5">
          {/* Waveform */}
          <div className="flex items-center gap-[3px] h-12">
            {bars.map((h,i)=>(
              <div key={i} className={`w-[3px] rounded-full transition-all ${phase==="listening"?"bg-primary":phase==="thinking"?"bg-primary/40":"bg-muted"}`}
                style={{
                  height: phase==="listening" ? `${Math.max(4, h * (0.6 + Math.sin(Date.now()/200+i)*0.4))}px` : phase==="thinking" ? `${4+Math.sin(i*0.8)*4}px` : "4px",
                  background: phase==="listening"
                    ? `hsl(${265+i*4},85%,${55+h*2}%)`
                    : phase==="thinking"
                      ? "rgba(155,109,250,0.4)"
                      : "rgba(255,255,255,0.08)",
                  transition: phase==="listening" ? `height ${80+i*15}ms ease-in-out` : "all 0.4s ease",
                  animationDelay:`${i*50}ms`,
                }}/>
            ))}
          </div>

          {/* Transcript */}
          <div className="w-full min-h-[40px] text-center">
            {transcript && (
              <p className="text-[13.5px] text-foreground/85 leading-relaxed" style={{fontFamily:"var(--font-display)"}}>
                "{transcript}{phase==="listening"?<span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-middle"/>:""}"
              </p>
            )}
            {phase==="idle" && !transcript && (
              <p className="text-[12px] text-muted-foreground font-mono">
                {mode==="quick" ? "Ask anything — get an instant answer" : "Describe a task — NC researches overnight"}
              </p>
            )}
            {phase==="thinking" && (
              <p className="text-[11.5px] text-success/60 font-mono animate-pulse">
                {mode==="quick" ? "Thinking…" : "Queuing overnight research…"}
              </p>
            )}
          </div>

          {/* Quick response */}
          {phase==="response" && response && (
            <div className="w-full rounded-2xl border border-primary/20 px-4 py-3.5"
              style={{background:"radial-gradient(ellipse at 0% 0%,rgba(155,109,250,0.08),transparent 60%)"}}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}>
                  <Zap size={9} style={{color:"var(--foreground)"}}/>
                </div>
                <Mono className="!text-success/60">NC · Quick answer</Mono>
              </div>
              <p className="text-[12.5px] text-foreground/80 leading-relaxed" style={{fontFamily:"var(--font-sans)"}}>{response}</p>
            </div>
          )}

          {/* Mic button */}
          <button
            onClick={phase==="idle"||phase==="response" ? startListening : undefined}
            className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
              phase==="listening"
                ? "bg-red-500/20 border-2 border-red-400 shadow-[0_0_30px_rgba(239,68,68,0.4)]"
                : "border-2 border-primary/40 hover:border-primary hover:shadow-[0_0_24px_rgba(155,109,250,0.35)]"
            }`}
            style={{background: phase==="listening" ? undefined : "linear-gradient(135deg,rgba(109,40,217,0.3),rgba(76,29,149,0.15))"}}>
            {phase==="listening"
              ? <MicOff size={22} className="text-red-400"/>
              : <Mic size={22} className="text-success"/>}
          </button>

          <p className="text-[10px] text-muted-foreground font-mono">
            {phase==="idle" ? "tap to speak" : phase==="listening" ? "listening… tap to stop" : phase==="thinking" ? "processing" : "tap to ask again"}
          </p>
        </div>

        {/* Footer hint */}
        {mode==="deep" && phase==="idle" && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-border" style={{background:"rgba(155,109,250,0.03)"}}>
            <Moon size={10} className="text-success/40 flex-shrink-0"/>
            <p className="text-[10.5px] text-muted-foreground font-mono">NC will run the research while you sleep · results by morning</p>
          </div>
        )}
        {mode==="quick" && phase==="idle" && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-border" style={{background:"rgba(6,182,212,0.02)"}}>
            <Volume2 size={10} className="text-professional/40 flex-shrink-0"/>
            <p className="text-[10.5px] text-muted-foreground font-mono">Grounded in your Memory, calendar, and live signals</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Proactive suggestions ────────────────────────────────────────────────────

const URGENCY_ICON: Record<string, React.ReactNode> = {
  high:   <CalendarDays size={11} className="text-red-400 flex-shrink-0"/>,
  medium: <TrendingUp   size={11} className="text-family flex-shrink-0"/>,
  low:    <Package      size={11} className="text-personal/70 flex-shrink-0"/>,
};

function ProactiveSuggestions({ onRunOvernight, onCompose }: {
  onRunOvernight:(text:string)=>void; onCompose:()=>void;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [expanded, setExpanded]   = useState<string|null>(null);
  const visible = PROACTIVE_SUGGESTIONS.filter(s=>!dismissed.includes(s.id));
  if(!visible.length) return null;

  return (
    <div className="flex-shrink-0 flex flex-col gap-1.5 px-3 lg:px-4">
      <div className="flex items-center gap-2">
        <Lightbulb size={10} className="text-success/60"/>
        <Mono>NC noticed · {visible.length} suggestion{visible.length>1?"s":""}</Mono>
      </div>
      {visible.map(s=>{
        const c = C[s.domain];
        const isOpen = expanded===s.id;
        return (
          <div key={s.id} className="rounded-2xl border overflow-hidden transition-all"
            style={{borderColor:`${c.hex}`,background:`radial-gradient(ellipse at 0% 0%,${c.glow},transparent 55%),var(--surface-elevated)`}}>
            <button className="w-full flex items-center gap-3 px-4 py-3 text-left hover:brightness-110 transition-all"
              onClick={()=>setExpanded(isOpen?null:s.id)}>
              <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`}}>
                <Lightbulb size={11} style={{color:c.icon}}/>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-semibold text-foreground/88 leading-snug truncate" style={{fontFamily:"var(--font-sans)"}}>{s.title}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {s.reasoning.map((r,i)=>(
                    <span key={i} className="text-[9px] font-mono text-muted-foreground">{i>0?"·":""} {r.source}</span>
                  ))}
                </div>
              </div>
              <ChevronUp size={11} className={`text-muted-foreground flex-shrink-0 transition-transform ${isOpen?"":"rotate-180"}`}/>
              <button onClick={e=>{ e.stopPropagation(); setDismissed(d=>[...d,s.id]); }}
                className="text-muted-foreground hover:text-muted-foreground transition-colors flex-shrink-0 ml-1">
                <X size={11}/>
              </button>
            </button>

            {isOpen && (
              <div className="border-t px-4 py-3.5 flex flex-col gap-3" style={{borderColor:`${c.hex}`}}>
                <p className="text-[11.5px] text-foreground/65 leading-relaxed" style={{fontFamily:"var(--font-sans)"}}>{s.body}</p>
                {/* Reasoning chain */}
                <div className="flex flex-col gap-1.5">
                  <Mono className="block mb-0.5">How NC connected this</Mono>
                  {s.reasoning.map((r,i)=>(
                    <div key={i} className="flex items-start gap-2.5">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px]" style={{background:C[r.domain].hex}}/>
                      <div className="flex-1 min-w-0">
                        <span className="text-[9.5px] font-mono text-muted-foreground mr-2">{r.source}</span>
                        <span className="text-[11px] text-foreground/65" style={{fontFamily:"var(--font-sans)"}}>{r.fact}</span>
                      </div>
                    </div>
                  ))}
                  {s.reasoning.length>1 && (
                    <div className="flex items-center gap-1.5 pl-4 pt-0.5">
                      <div className="h-px flex-1" style={{background:`linear-gradient(90deg,${c.hex},transparent)`}}/>
                      <span className="text-[9px] font-mono" style={{color:`${c.hex}`}}>cross-domain signal</span>
                    </div>
                  )}
                </div>
                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  {s.actionType==="overnight" && (
                    <button onClick={()=>{ onRunOvernight(s.action); setDismissed(d=>[...d,s.id]); }}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11.5px] font-medium transition-all"
                      style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`,border:`1px solid ${c.hex}`,color:c.icon,fontFamily:"var(--font-sans)"}}>
                      <Moon size={11}/> {s.action}
                    </button>
                  )}
                  {s.actionType==="compose" && (
                    <button onClick={()=>{ onCompose(); setDismissed(d=>[...d,s.id]); }}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11.5px] font-medium transition-all"
                      style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`,border:`1px solid ${c.hex}`,color:c.icon,fontFamily:"var(--font-sans)"}}>
                      <PenLine size={11}/> {s.action}
                    </button>
                  )}
                  <button onClick={()=>setDismissed(d=>[...d,s.id])}
                    className="px-3 py-2 rounded-xl text-[11px] text-muted-foreground border border-border hover:border-border hover:text-foreground transition-all" style={{fontFamily:"var(--font-sans)"}}>
                    Not now
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Explore drawer ──────────────────────────────────────────────────────────

const YOU_ITEMS: { id: MapView; label: string; Icon: React.ElementType; description: string }[] = [
  { id:"mindmap", label:"Mind Map",  Icon:Brain,      description:"Your life as a constellation — see how your domains and topics connect to each other." },
  { id:"memory",  label:"Memory",    Icon:Sparkles,   description:"Everything NC has learned about you — editable, correctable, and always yours." },
  { id:"signals", label:"Signals",   Icon:TrendingUp, description:"Patterns emerging across your life before you've consciously noticed them." },
];

function YouDrawer({ open, activeView, onClose, onNavigate }: {
  open:boolean; activeView:MapView|null;
  onClose:()=>void; onNavigate:(v:MapView)=>void;
}) {
  return (
    <div className={`absolute inset-0 z-20 flex items-stretch justify-end transition-opacity duration-200 ${open?"opacity-100 pointer-events-auto":"opacity-0 pointer-events-none"}`}>
      <div className="flex-1" onClick={onClose}/>
      <div className={`w-full max-w-[320px] h-full flex flex-col border-l border-border transition-transform duration-200 ease-out ${open?"translate-x-0":"translate-x-full"}`}
        style={{background:"var(--surface-elevated)",backdropFilter:"blur(20px)"}}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border flex-shrink-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}>
            <User size={11} style={{color:"var(--foreground)"}}/>
          </div>
          <div className="flex-1">
            <p className="text-[13.5px] font-semibold text-foreground/90" style={{fontFamily:"var(--font-display)"}}>You</p>
            <p className="text-[10px] text-muted-foreground font-mono mt-px">How NC understands your life</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X size={14}/></button>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto scrollbar-none p-4 flex flex-col gap-2">
          {YOU_ITEMS.map(item=>{
            const Icon = item.Icon;
            const isActive = activeView===item.id;
            return (
              <button key={item.id}
                onClick={()=>{ onNavigate(item.id); onClose(); }}
                className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl border text-left transition-all group ${
                  isActive
                    ? "border-primary/25 bg-primary/[0.07]"
                    : "border-border bg-muted hover:border-border hover:bg-muted"
                }`}>
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-px transition-colors ${isActive?"bg-primary/20":"bg-muted group-hover:bg-muted"}`}>
                  <Icon size={14} className={isActive?"text-success":"text-muted-foreground"}/>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className={`text-[13px] font-semibold ${isActive?"text-success":"text-foreground/80 group-hover:text-foreground"} transition-colors`} style={{fontFamily:"var(--font-sans)"}}>{item.label}</p>
                    {isActive && <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0"/>}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{item.description}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-4 border-t border-border">
          <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">NC builds this picture from your Gmail, Calendar, and connected sources. You can correct anything in Memory.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Ask NC command bar ───────────────────────────────────────────────────────

function AskNCBar({ open, onClose, onSubmit }: { open:boolean; onClose:()=>void; onSubmit:(text:string)=>void }) {
  const [input, setInput] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(()=>{ if(open) setTimeout(()=>ref.current?.focus(),80); },[open]);
  useEffect(()=>{
    const handler = (e:KeyboardEvent)=>{ if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  const submit = ()=>{ if(!input.trim()) return; onSubmit(input.trim()); setInput(""); onClose(); };

  if(!open) return null;
  return (
    // Mobile: bottom sheet. Desktop (md+): centered modal.
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center md:px-4" onClick={onClose}
      style={{background:"var(--scrim)",backdropFilter:"blur(12px)"}}>
      <div className="w-full md:max-w-[620px] max-h-[90vh] md:max-h-none flex flex-col gap-0 rounded-t-2xl md:rounded-2xl border border-primary/25 overflow-hidden shadow-2xl"
        style={{background:"var(--surface-elevated)",boxShadow:"0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(155,109,250,0.18)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border"
          style={{background:"linear-gradient(90deg,rgba(109,40,217,0.1),transparent)"}}>
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,var(--primary),var(--primary-glow))"}}>
            <Moon size={11} style={{color:"var(--foreground)"}}/>
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-foreground/90" style={{fontFamily:"var(--font-display)"}}>Ask NC to work on something overnight</p>
            <p className="text-[10.5px] text-muted-foreground font-mono mt-px">Results delivered by morning · powered by deep research agents</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X size={13}/></button>
        </div>

        {/* Input */}
        <div className="px-5 py-4">
          <textarea ref={ref} value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter" && (e.metaKey||e.ctrlKey)) submit(); }}
            placeholder="e.g. Find me a dress for Maya's wedding — mid-June, budget £200, not too formal…"
            rows={3}
            className="w-full bg-muted border border-border rounded-xl px-4 py-3 text-[13px] text-foreground/80 placeholder:text-muted-foreground outline-none resize-none leading-relaxed scrollbar-none focus:border-primary/40 transition-colors"
            style={{fontFamily:"var(--font-sans)"}}/>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[10px] text-muted-foreground font-mono">⌘↵ to submit · Esc to close</p>
            <p className="text-[10px] text-muted-foreground font-mono">{input.length > 0 ? `${input.length} chars` : ""}</p>
          </div>
        </div>

        {/* Suggested tasks */}
        <div className="px-5 pb-4 flex flex-col gap-2">
          <Mono className="block mb-1">Try asking</Mono>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {SUGGESTED_TASKS.map(({icon:Icon,text},i)=>(
              <button key={i} onClick={()=>setInput(text)}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-border bg-muted hover:border-primary/25 hover:bg-primary/[0.05] transition-all text-left group">
                <Icon size={11} className="text-muted-foreground group-hover:text-success/60 flex-shrink-0 transition-colors"/>
                <span className="text-[11.5px] text-muted-foreground group-hover:text-foreground/80 leading-snug transition-colors" style={{fontFamily:"var(--font-sans)"}}>{text}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-border"
          style={{background:"rgba(255,255,255,0.01)"}}>
          <div className="flex items-center gap-1.5 flex-1">
            {(["Learning","Personal","Professional"] as const).map(d=>{
              const id = d.toLowerCase() as DomainId;
              const c = C[id];
              return (
                <span key={d} className="flex items-center gap-1 px-2 py-px rounded-full text-[9.5px] font-mono border"
                  style={{color:c.hex,borderColor:`${c.hex}`,background:`${c.hex}`}}>
                  <span className="w-1 h-1 rounded-full" style={{background:c.hex}}/>{d}
                </span>
              );
            })}
            <span className="text-[9.5px] text-muted-foreground font-mono">NC will route to the right domain</span>
          </div>
          <button onClick={submit} disabled={!input.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-semibold transition-all disabled:opacity-35 disabled:cursor-not-allowed"
            style={{background:"linear-gradient(135deg,rgba(109,40,217,0.6),rgba(76,29,149,0.4))",border:"1px solid rgba(155,109,250,0.35)",color:"#ede9fe",fontFamily:"var(--font-sans)"}}>
            <Moon size={12}/> Run overnight
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tasks canvas ─────────────────────────────────────────────────────────────

function ScoutCanvas({ tasks, onNewTask }: { tasks: AgentTask[]; onNewTask:()=>void }) {
  const [expanded, setExpanded] = useState<string|null>("a1");
  const statusIcon = (s:TaskStatus) => s==="done"
    ? <Check size={11} className="text-personal"/>
    : s==="running"
      ? <Loader size={11} className="text-success animate-spin"/>
      : <Clock size={11} className="text-muted-foreground"/>;
  const statusLabel: Record<TaskStatus,string> = { done:"Completed", running:"Running now", queued:"Queued" };
  const statusColor: Record<TaskStatus,string> = {
    done:"text-personal bg-emerald-500/10 border-emerald-500/20",
    running:"text-success bg-primary/10 border-primary/25",
    queued:"text-muted-foreground bg-muted border-border",
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <p className="text-[18px] font-semibold text-foreground" style={{fontFamily:"var(--font-display)"}}>Scout</p>
          <p className="text-[12px] text-muted-foreground mt-0.5" style={{fontFamily:"var(--font-sans)"}}>NC researches while you sleep. Results waiting in the morning.</p>
        </div>
        <button onClick={onNewTask}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-semibold border border-primary/30 text-success bg-primary/10 hover:bg-primary/15 transition-all"
          style={{fontFamily:"var(--font-sans)"}}>
          <Plus size={13}/> New Scout
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-none">
        <div className="max-w-2xl mx-auto px-4 py-5 flex flex-col gap-3">

          {/* Running indicator */}
          {tasks.some(t=>t.status==="running") && (
            <div className="rounded-xl border border-primary/20 px-4 py-3 flex items-center gap-3"
              style={{background:"radial-gradient(ellipse at 0% 50%,rgba(155,109,250,0.07),transparent 60%)"}}>
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse flex-shrink-0" style={{boxShadow:"0 0 8px rgba(155,109,250,0.8)"}}/>
              <p className="text-[12px] text-foreground/70 flex-1" style={{fontFamily:"var(--font-sans)"}}>
                1 agent running now · research in progress · results by morning
              </p>
              <Mono>11:58 PM</Mono>
            </div>
          )}

          {tasks.map(task=>{
            const c = C[task.domain];
            const isOpen = expanded===task.id;
            return (
              <div key={task.id} className={`rounded-2xl border transition-all overflow-hidden ${task.status==="done"?"border-border hover:border-border":"border-border"}`}
                style={{background:"var(--surface-elevated)"}}>

                {/* Task header */}
                <button className="w-full flex items-start gap-3 px-5 py-4 text-left"
                  onClick={()=>setExpanded(isOpen?null:task.id)}>
                  <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0 mt-px"
                    style={{background:`linear-gradient(135deg,${c.tile},${c.tile})`,boxShadow:`0 1px 8px ${c.glow}`}}>
                    {statusIcon(task.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="text-[13px] font-semibold text-foreground/90" style={{fontFamily:"var(--font-sans)"}}>{task.title}</p>
                      <span className={`px-1.5 py-px rounded-full text-[8.5px] font-mono border ${statusColor[task.status]}`}>{statusLabel[task.status]}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-1">{task.input}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <Mono>{task.createdAt}</Mono>
                      {task.completedAt && <Mono className="!text-personal/50">Done {task.completedAt} · {task.duration}</Mono>}
                    </div>
                  </div>
                  <ChevronRight size={13} className={`text-muted-foreground flex-shrink-0 mt-1 transition-transform ${isOpen?"rotate-90":""}`}/>
                </button>

                {/* Expanded: agent steps + results */}
                {isOpen && (
                  <div className="border-t border-border">
                    {/* Agent steps */}
                    {task.agentSteps && (
                      <div className="px-5 py-4 border-b border-border">
                        <Mono className="block mb-3">Agent steps</Mono>
                        <div className="flex flex-col gap-2">
                          {task.agentSteps.map((step,i)=>(
                            <div key={i} className="flex items-start gap-3">
                              <div className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-px border ${task.status==="done"?"border-emerald-500/30 bg-emerald-500/10":"border-primary/25 bg-primary/8"}`}>
                                {task.status==="done"
                                  ? <Check size={8} className="text-personal"/>
                                  : i===0
                                    ? <Loader size={8} className="text-success animate-spin"/>
                                    : <span className="w-1 h-1 rounded-full bg-muted-foreground/30"/>}
                              </div>
                              <p className="text-[11.5px] text-foreground/65 leading-snug" style={{fontFamily:"var(--font-sans)"}}>{step}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Running — progress state */}
                    {task.status==="running" && !task.result && (
                      <div className="px-5 py-4 flex items-center gap-3">
                        <Loader size={12} className="text-success animate-spin flex-shrink-0"/>
                        <p className="text-[12px] text-muted-foreground" style={{fontFamily:"var(--font-sans)"}}>Researching across sources — checking back at 6am…</p>
                      </div>
                    )}

                    {/* Results */}
                    {task.result && (
                      <div className="px-5 py-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Sparkles size={11} className="text-success/70"/>
                          <Mono>Results</Mono>
                        </div>
                        <p className="text-[12px] text-foreground/70 leading-relaxed mb-4" style={{fontFamily:"var(--font-sans)"}}>{task.result.summary}</p>
                        <div className="flex flex-col gap-2">
                          {task.result.items.map((item,i)=>(
                            <div key={i} className={`rounded-xl border px-4 py-3 flex items-start gap-3 transition-all hover:border-border ${i===0?"border-primary/20 bg-primary/[0.04]":"border-border bg-muted"}`}>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <p className="text-[12.5px] font-semibold text-foreground/90" style={{fontFamily:"var(--font-sans)"}}>{item.name}</p>
                                  {i===0 && <span className="text-[8px] font-mono px-1.5 py-px rounded-full bg-primary/15 text-success border border-primary/25">Top pick</span>}
                                  <span className="text-[9px] font-mono text-personal/70 ml-auto">{item.match}% match</span>
                                </div>
                                <p className="text-[11px] text-muted-foreground leading-snug mb-1.5">{item.note}</p>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-mono text-muted-foreground">{item.source}</span>
                                  <span className="text-[12px] font-semibold" style={{color:C[task.domain].hex}}>{item.price}</span>
                                </div>
                              </div>
                              <button className="flex-shrink-0 text-muted-foreground hover:text-foreground/60 transition-colors mt-px">
                                <ExternalLink size={11}/>
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border">
                          <button className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11.5px] font-medium bg-primary/15 border border-primary/25 text-success hover:bg-primary/20 transition-all" style={{fontFamily:"var(--font-sans)"}}>
                            <Check size={11}/> Save to {task.domain}
                          </button>
                          <button className="px-3.5 py-2 rounded-xl border border-border text-muted-foreground text-[11.5px] hover:text-foreground hover:border-border transition-all" style={{fontFamily:"var(--font-sans)"}}>Refine search</button>
                          <button className="px-3.5 py-2 rounded-xl text-muted-foreground text-[11.5px] hover:text-foreground transition-all ml-auto" style={{fontFamily:"var(--font-sans)"}}>Dismiss</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Empty queue callout */}
          <div className="rounded-2xl border border-dashed border-border px-6 py-8 flex flex-col items-center gap-3 text-center cursor-pointer hover:border-primary/20 transition-colors group" onClick={onNewTask}>
            <div className="w-10 h-10 rounded-xl bg-muted group-hover:bg-primary/[0.06] border border-border group-hover:border-primary/20 flex items-center justify-center transition-all">
              <Moon size={16} className="text-muted-foreground group-hover:text-success/50 transition-colors"/>
            </div>
            <p className="text-[12.5px] text-muted-foreground group-hover:text-muted-foreground transition-colors" style={{fontFamily:"var(--font-sans)"}}>
              Delegate something to NC before you sleep
            </p>
            <span className="text-[10.5px] text-success/50 font-mono group-hover:text-success/70 transition-colors">+ New Scout</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function MainApp() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [mapView,     setMapView]     = useState<MapView|null>(null);
  const [tool,        setTool]        = useState<Tool>(null);
  const [domain,      setDomain]      = useState<DomainId|"other"|null>(null);
  const [voiceOpen,   setVoiceOpen]   = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [testOpen,    setTestOpen]    = useState(false);
  const [tasks,       setTasks]       = useState<AgentTask[]>(AGENT_TASKS);
  const [doneIds,     setDoneIds]     = useState<Set<string>>(() => new Set());
  const resolveItem   = (id: string) => setDoneIds(s => { const n = new Set(s); n.add(id); return n; });
  const unresolveItem = (id: string) => setDoneIds(s => { const n = new Set(s); n.delete(id); return n; });

  const handleDomain  = (id: DomainId) => { setDomain(id); setTool(null); setMapView(null); setExploreOpen(false); };
  const handleOther   = () => { setDomain("other"); setTool(null); setMapView(null); setExploreOpen(false); };
  const handleMap     = (v: MapView|null) => { setMapView(v); setDomain(null); setTool(null); setExploreOpen(false); };
  const handleVoice   = () => setVoiceOpen(true);
  const handleExplore = () => setExploreOpen(o=>!o);
  const handleTest    = () => setTestOpen(true);
  const handleSubmitTask = (text: string) => {
    const newTask: AgentTask = {
      id:`a${Date.now()}`, title:text.slice(0,60)+(text.length>60?"…":""),
      input:text, status:"queued", domain:"personal", createdAt:"Queued · just now",
    };
    setTasks(t=>[...t,newTask]);
    handleMap("tasks");
  };

  return (
    // overflow-x: clip (NOT hidden) — clip prevents horizontal page scroll
    // without turning this div into a scroll container. `overflow-x: hidden`
    // implicitly sets `overflow-y: auto`, which traps `position: sticky`
    // descendants (they pin relative to *this* container instead of the
    // window, and since this container's min-height is 100dvh but content
    // can grow taller, the container doesn't actually scroll internally —
    // the page does — so sticky never engages). `clip` doesn't create a
    // scroll context, so sticky elements correctly resolve to the window.
    <div className="min-h-[100dvh] w-full overflow-x-clip text-foreground" style={{fontFamily:"var(--font-sans)"}}>
      <div className="relative z-10 flex flex-col min-h-[100dvh]">
        {/* TopBar — desktop only. On mobile the logo + nav pills aren't doing
            functional work (pills hidden, logo isn't a back button anywhere
            you'd navigate from on the home), so it just wastes the area
            below the iOS status bar. HomeCanvas handles safe-area inset
            directly on mobile (pt-[env(safe-area-inset-top)]). */}
        <div className="hidden md:block sticky top-0 z-30 bg-background backdrop-blur-md pt-4 lg:pt-6">
          <TopBar
            mapView={mapView} setMapView={handleMap}
            tool={tool} setTool={setTool}
            onDomain={handleDomain} onVoice={handleVoice} onExplore={handleExplore} onTest={handleTest}
          />
        </div>

        <div className="flex-1 relative flex flex-col" style={{minHeight:"calc(100dvh - 56px)"}}>
          {/* Main canvas */}
          {!mapView && <HomeCanvas onDomain={handleDomain} onOther={handleOther} doneIds={doneIds}/>}
          {mapView==="mindmap" && <MindMapCanvas/>}
          {mapView==="memory"  && <MemoryCanvas/>}
          {mapView==="signals" && <SignalsCanvas/>}
          {mapView==="tasks"   && <ScoutCanvas tasks={tasks} onNewTask={()=>setVoiceOpen(true)}/>}

          {/* You drawer */}
          <YouDrawer
            open={exploreOpen} activeView={mapView}
            onClose={()=>setExploreOpen(false)} onNavigate={handleMap}
          />

          {/* Domain detail drawer */}
          {domain && !exploreOpen && <DomainDetail domainId={domain} onClose={()=>setDomain(null)} onCompose={()=>setTool("compose")} doneIds={doneIds} onResolve={resolveItem} onUnresolve={unresolveItem}/>}
        </div>
      </div>

      {/* Mobile-only bottom action bar — single primary entry to chat.
          Hides when any modal is open. Other intents (Search/Task/Draft)
          are chips inside the ChatPanel empty state, two taps away. */}
      {tool === null && !voiceOpen && !exploreOpen && !domain && (
        <MobileQuickBar
          onChat={() => setTool("chat")}
          onCompose={() => setTool("compose")}
          onYou={handleExplore}
          onTest={handleTest}
          onSignOut={async () => { await signOut(); navigate({ to: "/auth" }); }}
        />
      )}

      {/* Modals */}
      <VoiceBar   open={voiceOpen}     onClose={()=>setVoiceOpen(false)} onSubmitTask={handleSubmitTask}/>
      <ChatPanel  open={tool==="chat"}    onClose={()=>setTool(null)} onSwitchToCompose={()=>setTool("compose")}/>
      <ComposePanel open={tool==="compose"} onClose={()=>setTool(null)}/>


      <div className="pointer-events-none fixed top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent"/>
    </div>
  );
}

// ─── AddTaskButton ────────────────────────────────────────────────────────────
// Header button + lightweight modal for entering a free-text task. The task
// text is run through the keyword classifier in `manual-tasks.ts`, persisted
// to localStorage, and shows up in the matching bento box on the home canvas.

function AddTaskButton() {
  const { addTasks } = useManualTasks();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceLang, setVoiceLang] = useState<string>(() => {
    if (typeof window === "undefined") return "en-US";
    return localStorage.getItem("voice-lang") || (navigator.language || "en-US");
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("voice-lang", voiceLang);
  }, [voiceLang]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // SpeechRecognition is a browser API not in TS lib types; cast loosely.
  const recogRef = useRef<any>(null);

  // Web Speech API support — Chrome/Edge/Safari expose it on window under
  // different prefixes. We feature-detect once on mount.
  const speechSupported =
    typeof window !== "undefined" &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const previews = useMemo(() => {
    return text
      .split(/\r?\n/)
      .map((raw) => raw.replace(/^\s*[-*•·–—]\s+/, "").replace(/^\s*\d+[.)]\s+/, "").trim())
      .filter(Boolean)
      .map((line) => ({ line, ...classifyTask(line) }));
  }, [text]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Stop recognition when the modal closes.
  useEffect(() => {
    if (!open && recogRef.current) {
      try { recogRef.current.stop(); } catch { /* noop */ }
      recogRef.current = null;
      setListening(false);
    }
  }, [open]);

  const startListening = () => {
    if (!speechSupported) {
      setVoiceError("Voice input isn't supported in this browser. Try Chrome or Safari.");
      return;
    }
    setVoiceError(null);
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recog = new Ctor();
    recog.continuous = true;       // keep listening across pauses
    recog.interimResults = true;   // show partial transcripts as they arrive
    recog.lang = voiceLang || navigator.language || "en-US";
    // Some engines support alternative results — request a few so accented
    // speech has more chances to match the right word.
    try { recog.maxAlternatives = 3; } catch { /* noop */ }

    // Track the text we had when dictation started so we can append cleanly
    // and keep what the user already typed.
    const baseText = text.endsWith("\n") || text === "" ? text : text + "\n";
    // Buffer of completed phrases that share the *current* line. We prefer
    // sentence boundaries over raw pauses, so a mid-thought pause like
    // "pick up tickets from … ballet at five" stays on one line.
    const lines: string[] = [""]; // lines[lines.length-1] is the active line
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const SILENCE_MS = 1600;
    const CONTINUATION_WORDS = new Set([
      "a", "an", "the", "and", "or", "but", "so", "because", "if", "then",
      "than", "that", "which", "who", "whom", "whose", "when", "while", "until",
      "to", "for", "from", "of", "in", "on", "at", "by", "with", "about", "into",
      "over", "under", "after", "before", "between", "through", "during", "without",
      "within", "around", "near", "as", "is", "are", "was", "were", "be", "been",
      "being", "have", "has", "had", "do", "does", "did", "can", "could", "should",
      "would", "will", "just", "my", "your", "our", "their", "his", "her", "its",
      "this", "these", "those",
    ]);
    const TASK_ACTION_WORDS = new Set([
      "add", "ask", "book", "bring", "buy", "call", "check", "clean", "confirm",
      "drop", "draft", "email", "finish", "fix", "follow", "get", "go", "grab",
      "make", "message", "order", "pack", "pay", "pick", "plan", "prepare", "reply",
      "schedule", "send", "shop", "submit", "take", "text", "update", "visit", "watch",
      "write",
    ]);
    const NON_COMMAND_STARTERS = new Set([
      "i", "i'm", "im", "ive", "i've", "we", "we're", "were", "you", "you're",
      "he", "she", "they", "it", "there",
    ]);

    const render = (interim = "") => {
      const joined = lines.join("\n").replace(/\s+$/g, "");
      const tail = interim ? (joined ? " " : "") + interim : "";
      setText(baseText + joined + tail);
    };

    const breakLine = () => {
      if (lines[lines.length - 1].trim()) lines.push("");
    };

    const shouldBreakOnSilence = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/[.!?]$/.test(trimmed)) return true;

      const words = trimmed.split(/\s+/);
      const firstWord = words[0]?.replace(/[^\p{L}\p{N}:']/gu, "").toLowerCase();
      const lastWord = words[words.length - 1]?.replace(/[^\p{L}\p{N}:']/gu, "").toLowerCase();
      if (!lastWord) return false;
      if (CONTINUATION_WORDS.has(lastWord)) return false;

      const tail = words.slice(-3).join(" ").toLowerCase();
      if (/\b(at|by|before|after)\s+\d/.test(tail)) return true;
      if (/\b(am|pm|tomorrow|today|tonight)\b/.test(tail)) return true;
      if (
        words.length >= 3 &&
        words.length <= 5 &&
        firstWord &&
        TASK_ACTION_WORDS.has(firstWord) &&
        !NON_COMMAND_STARTERS.has(firstWord)
      ) {
        return true;
      }

      return words.length >= 4;
    };

    recog.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = String(result[0].transcript || "").trim();
        if (!transcript) continue;
        if (result.isFinal) {
          // Strip an explicit "new task" / "next task" cue and force a break.
          const cueRe = /^(new task|next task|next)[\s,:.-]*/i;
          let phrase = transcript;
          let forceBreak = false;
          if (cueRe.test(phrase)) {
            phrase = phrase.replace(cueRe, "").trim();
            forceBreak = true;
          }
          if (forceBreak) breakLine();
          if (phrase) {
            const cur = lines[lines.length - 1];
            lines[lines.length - 1] = cur ? cur + " " + phrase : phrase;
          }
          // Sentence-ending punctuation → new line for the next phrase.
          if (/[.!?]$/.test(phrase)) breakLine();
          // Reset silence timer — a long pause only commits a line break when
          // the current line already looks like a complete sentence/task.
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            if (shouldBreakOnSilence(lines[lines.length - 1] ?? "")) breakLine();
            render();
          }, SILENCE_MS);
        } else {
          interim += (interim ? " " : "") + transcript;
        }
      }
      render(interim);
    };
    recog.onerror = (e: any) => {
      const msg = e?.error === "not-allowed"
        ? "Microphone access denied. Enable it in your browser settings."
        : `Voice error: ${e?.error || "unknown"}`;
      setVoiceError(msg);
      setListening(false);
    };
    recog.onend = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      setListening(false);
      recogRef.current = null;
    };

    try {
      recog.start();
      recogRef.current = recog;
      setListening(true);
    } catch {
      setVoiceError("Couldn't start the microphone. Try again.");
    }
  };

  const stopListening = () => {
    if (recogRef.current) {
      try { recogRef.current.stop(); } catch { /* noop */ }
    }
    setListening(false);
  };

  const submit = () => {
    stopListening();
    const created = addTasks(text);
    if (!created.length) return;
    setText("");
    setOpen(false);
  };

  const domainColor = Object.fromEntries(DOMAIN_ORDER.map(id => [id, C[id].hex])) as Record<DomainId, string>;

  return (
    <>
      <ActionPill
        icon={<ListTodo size={14}/>}
        label="Add tasks"
        accent="var(--family)"
        title="Add tasks (type or dictate)"
        onClick={() => setOpen(true)}
      />

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-foreground/30 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-border p-5 shadow-2xl"
            style={{ background: "radial-gradient(ellipse at 0% 0%,rgba(139,92,246,0.10) 0%,transparent 60%),var(--surface-elevated)" }}
          >
            <div className="flex items-center gap-2 mb-3">
              <ListTodo size={14} className="text-success" />
              <h2 className="text-[13px] font-semibold text-foreground/90 font-display">Add tasks</h2>
              <span className="text-[10.5px] font-mono text-muted-foreground">type or dictate · one per line</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="ml-auto text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>

            <div className="relative">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={5}
                placeholder={"Type or tap the mic to dictate…\nReply to Sarah about partnership terms\nPick up kids from ballet at 5"}
                className="w-full bg-muted border border-border rounded-xl px-3 py-2.5 pr-12 text-[13px] outline-none placeholder:text-muted-foreground focus:border-primary/40 focus:bg-muted resize-none font-mono leading-relaxed"
              />

              {/* Mic button — toggles dictation. Pulses red while listening so
                  it's visually obvious the mic is hot. */}
              <button
                type="button"
                onClick={listening ? stopListening : startListening}
                title={listening ? "Stop dictation" : speechSupported ? "Dictate tasks" : "Voice not supported in this browser"}
                aria-label={listening ? "Stop dictation" : "Start dictation"}
                disabled={!speechSupported}
                className={`absolute top-2 right-2 w-8 h-8 rounded-lg flex items-center justify-center border transition-all disabled:opacity-30 disabled:cursor-not-allowed after:content-[''] after:absolute after:-inset-1.5 after:md:hidden ${
                  listening
                    ? "border-rose-400/50 bg-rose-500/15 text-social animate-pulse shadow-[0_0_14px_rgba(248,113,113,0.5)]"
                    : "border-border bg-muted text-muted-foreground hover:text-success hover:border-primary/40 hover:bg-primary/10"
                }`}
              >
                <Mic size={14}/>
              </button>
            </div>

            {voiceError && (
              <div className="mt-2 text-[11px] text-social/90 font-mono">{voiceError}</div>
            )}

            {/* Voice language picker — accent/locale hint dramatically improves
                recognition for non-native English speakers. Persisted locally. */}
            {speechSupported && (
              <div className="mt-2 flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                <Mic size={11} className="opacity-60"/>
                <span>Voice language</span>
                <select
                  value={voiceLang}
                  onChange={(e) => setVoiceLang(e.target.value)}
                  disabled={listening}
                  className="bg-muted border border-border rounded-md px-1.5 py-0.5 text-foreground/80 text-[11px] outline-none focus:border-primary/40 disabled:opacity-50"
                >
                  <optgroup label="English">
                    <option value="en-US">English (US)</option>
                    <option value="en-GB">English (UK)</option>
                    <option value="en-IN">English (India)</option>
                    <option value="en-AU">English (Australia)</option>
                    <option value="en-CA">English (Canada)</option>
                    <option value="en-IE">English (Ireland)</option>
                    <option value="en-ZA">English (South Africa)</option>
                    <option value="en-NG">English (Nigeria)</option>
                    <option value="en-PH">English (Philippines)</option>
                    <option value="en-SG">English (Singapore)</option>
                  </optgroup>
                  <optgroup label="Other">
                    <option value="es-ES">Español (España)</option>
                    <option value="es-MX">Español (México)</option>
                    <option value="fr-FR">Français</option>
                    <option value="de-DE">Deutsch</option>
                    <option value="it-IT">Italiano</option>
                    <option value="pt-BR">Português (Brasil)</option>
                    <option value="pt-PT">Português (Portugal)</option>
                    <option value="nl-NL">Nederlands</option>
                    <option value="pl-PL">Polski</option>
                    <option value="sv-SE">Svenska</option>
                    <option value="tr-TR">Türkçe</option>
                    <option value="ru-RU">Русский</option>
                    <option value="ar-SA">العربية</option>
                    <option value="hi-IN">हिन्दी</option>
                    <option value="bn-IN">বাংলা</option>
                    <option value="ta-IN">தமிழ்</option>
                    <option value="te-IN">తెలుగు</option>
                    <option value="mr-IN">मराठी</option>
                    <option value="ur-PK">اردو</option>
                    <option value="zh-CN">中文 (简体)</option>
                    <option value="zh-TW">中文 (繁體)</option>
                    <option value="ja-JP">日本語</option>
                    <option value="ko-KR">한국어</option>
                    <option value="vi-VN">Tiếng Việt</option>
                    <option value="th-TH">ไทย</option>
                    <option value="id-ID">Bahasa Indonesia</option>
                    <option value="fil-PH">Filipino</option>
                  </optgroup>
                </select>
                <span className="text-muted-foreground">tip: pick your accent for better accuracy</span>
              </div>
            )}

            {listening && !voiceError && (
              <div className="mt-2 text-[11px] text-social/90 font-mono flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse"/>
                Listening — pause between tasks; each phrase becomes a new line.
              </div>
            )}

            {previews.length > 0 && (
              <div className="mt-3 max-h-40 overflow-y-auto space-y-1 pr-1">
                {previews.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground/80">
                    <span
                      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: domainColor[p.domain], boxShadow: `0 0 8px ${domainColor[p.domain]}` }}
                    />
                    <span className="capitalize text-foreground/80 w-20 flex-shrink-0">{p.domain}</span>
                    <span className="truncate text-foreground/60">{p.line}</span>
                    {p.urgent && <span className="text-social flex-shrink-0">urgent</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between">
              <div className="text-[11px] text-muted-foreground font-mono">
                {previews.length === 0
                  ? "Auto-categorised into the right bento box"
                  : `${previews.length} task${previews.length === 1 ? "" : "s"} · ⌘/Ctrl+Enter to add`}
              </div>
              <button
                onClick={submit}
                disabled={previews.length === 0}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12px] font-medium border border-primary/40 bg-primary/15 text-success hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                style={{ fontFamily: "'DM Sans',sans-serif" }}
              >
                <Plus size={12} />
                Add {previews.length > 1 ? `${previews.length} tasks` : "task"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default MainApp;
