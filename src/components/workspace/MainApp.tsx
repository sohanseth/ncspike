import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen, Heart, MessageCircle, Briefcase, ShoppingBag,
  Brain, TrendingUp, Zap, ArrowRight, Check,
  Send, X, ChevronDown, PenLine, Shield,
  Layers, RefreshCw, ChevronRight, Sparkles,
  Moon, Clock, Loader, ExternalLink, Star, ShoppingCart,
  Search, Mic, MicOff, Lightbulb, Volume2,
  Flag, RotateCcw, Bell, User, Plus, ChevronUp, CalendarDays, Calendar, Package, Plug, LogOut, Mail, Inbox,
} from "lucide-react";


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
type AIModel        = "flash" | "pro" | "gpt5" | "private";

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

const C: Record<DomainId, {
  text: string; border: string; dot: string; bar: string;
  hex: string; light: string; glow: string; tile: string; icon: string;
}> = {
  learning:     { text:"text-violet-400",  border:"border-violet-400/20",  dot:"bg-violet-400/60",  bar:"bg-violet-400",   hex:"#8b5cf6", light:"#c4b5fd", glow:"rgba(139,92,246,0.2)",  tile:"#6d28d9", icon:"#ede9fe" },
  professional: { text:"text-sky-400",     border:"border-sky-400/20",     dot:"bg-sky-400/60",     bar:"bg-sky-400",      hex:"#38bdf8", light:"#7dd3fc", glow:"rgba(56,189,248,0.18)", tile:"#0284c7", icon:"#e0f2fe" },
  social:       { text:"text-rose-400",    border:"border-rose-400/20",    dot:"bg-rose-400/60",    bar:"bg-rose-400",     hex:"#fb7185", light:"#fda4af", glow:"rgba(251,113,133,0.18)",tile:"#e11d48", icon:"#ffe4e6" },
  family:       { text:"text-amber-400",   border:"border-amber-400/20",   dot:"bg-amber-400/60",   bar:"bg-amber-400",    hex:"#fbbf24", light:"#fde68a", glow:"rgba(251,191,36,0.18)", tile:"#d97706", icon:"#fef3c7" },
  personal:     { text:"text-emerald-400", border:"border-emerald-400/20", dot:"bg-emerald-400/60", bar:"bg-emerald-400",  hex:"#34d399", light:"#6ee7b7", glow:"rgba(52,211,153,0.16)", tile:"#059669", icon:"#d1fae5" },
};

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
  high:"text-emerald-300 border-emerald-500/25 bg-emerald-500/10",
  medium:"text-amber-300 border-amber-500/25 bg-amber-500/10",
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
              style={{background:`linear-gradient(135deg, ${c.tile}dd, ${c.tile}88)`,boxShadow:`0 2px 12px ${c.glow}`}}>
              <Icon size={16} style={{color:c.icon}}/>
              {urgentCount>0 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-red-500 border border-background flex items-center justify-center text-[7px] font-bold text-white">{urgentCount}</span>
              )}
            </div>
            <span className="text-[8.5px] font-mono text-muted-foreground/50 tracking-wide hidden sm:block">{d.label.slice(0,4).toUpperCase()}</span>
          </button>
        );
      })}
    </div>
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
    <header className="h-14 flex items-center px-4 gap-3 border-b border-border flex-shrink-0 relative z-30">
      {/* Logo */}
      <button onClick={()=>{ setMapView(null); setTool(null); }} className="flex items-center gap-2 hover:opacity-80 transition-opacity flex-shrink-0">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9566)",boxShadow:"0 0 14px rgba(139,92,246,0.3)"}}>
          <Zap size={13} style={{color:"#ddd6fe"}}/>
        </div>
        <span className="text-[13px] font-semibold tracking-tight text-foreground/80 hidden lg:block" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>NeuralConnexions</span>
      </button>

      <div className="w-px h-6 bg-border mx-1 hidden md:block"/>

      {/* Domain tiles */}
      <div className="hidden md:flex">
        <DomainTiles onDomain={onDomain}/>
      </div>

      {/* Primary actions — Voice, Chat, Compose */}
      <div className="ml-auto flex items-center gap-2">
        {/* Voice */}
        <button onClick={onVoice}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border border-white/[0.1] text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.05] transition-all flex-shrink-0"
          style={{fontFamily:"'DM Sans',sans-serif"}}>
          <Mic size={13}/>
          <span className="hidden sm:block">Voice</span>
        </button>

        {/* Chat */}
        <button onClick={()=>setTool(tool==="chat"?null:"chat")}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border transition-all flex-shrink-0 ${
            tool==="chat"
              ? "bg-primary/15 text-primary border-primary/30 shadow-[0_0_16px_rgba(155,109,250,0.2)]"
              : "border-white/[0.1] text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.05]"
          }`}
          style={{fontFamily:"'DM Sans',sans-serif"}}>
          <MessageCircle size={13}/>
          <span className="hidden sm:block">Chat</span>
        </button>

        {/* Compose */}
        <button onClick={()=>setTool(tool==="compose"?null:"compose")}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border transition-all flex-shrink-0 ${
            tool==="compose"
              ? "bg-primary/15 text-primary border-primary/30 shadow-[0_0_16px_rgba(155,109,250,0.2)]"
              : "border-white/[0.1] text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.05]"
          }`}
          style={{fontFamily:"'DM Sans',sans-serif"}}>
          <PenLine size={13}/>
          <span className="hidden sm:block">Compose</span>
        </button>

        <div className="w-px h-5 bg-border mx-1"/>

        {/* You */}
        <button onClick={onExplore}
          className={`relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border transition-all flex-shrink-0 ${
            ["mindmap","memory","signals"].includes(mapView??"")
              ? "bg-white/[0.08] text-foreground/90 border-white/[0.15]"
              : "border-white/[0.08] text-muted-foreground hover:text-foreground hover:border-white/15 hover:bg-white/[0.04]"
          }`}
          style={{fontFamily:"'DM Sans',sans-serif"}}>
          <User size={13}/>
          <span className="hidden sm:block">You</span>
        </button>

        {/* Connections */}
        <Link to="/workspace/connections"
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border border-white/[0.1] text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.05] transition-all flex-shrink-0"
          style={{fontFamily:"'DM Sans',sans-serif"}}
          title="Connect Gmail & Calendar">
          <Plug size={13}/>
          <span className="hidden sm:block">Connect</span>
        </Link>

        {/* Test */}
        <button onClick={onTest}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all flex-shrink-0"
          style={{fontFamily:"'DM Sans',sans-serif"}}
          title="Test Scout & OAuth">
          <Sparkles size={13}/>
          <span className="hidden sm:block">Test</span>
        </button>

        <div className="w-px h-5 bg-border mx-1"/>

        {/* Avatar */}
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
          style={{background:"linear-gradient(135deg,#6d28d9,#4c1d95)",color:"#ede9fe"}}>S</div>

        {/* Sign out */}
        <button onClick={handleSignOut} title="Sign out" aria-label="Sign out"
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-medium border border-white/[0.1] text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.05] transition-all flex-shrink-0"
          style={{fontFamily:"'DM Sans',sans-serif"}}>
          <LogOut size={13}/>
          <span className="hidden sm:block">Sign out</span>
        </button>
      </div>
    </header>
  );
}

// ─── Bento domain card ────────────────────────────────────────────────────────

function DomainCard({ domain, size, onClick, liveItems, liveCount }: {
  domain:DomainData; size:"xl"|"lg"|"md"|"sm"; onClick:()=>void;
  liveItems?: Array<{ id:string|number; text:string; meta:string; urgent:boolean; progress:number }>;
  liveCount?: number;
}) {
  const c=C[domain.id]; const { Icon }=domain;
  const maxItems = size==="xl"?4:size==="lg"?3:size==="md"?2:1;
  const items = liveItems && liveItems.length ? liveItems : domain.items;
  const activity = liveCount !== undefined ? Math.min(1, liveCount / 5) : domain.activity;
  return (
    <div onClick={onClick} className={`h-full rounded-2xl border ${c.border} cursor-pointer overflow-hidden flex flex-col p-4 gap-3 transition-all hover:brightness-110 group`}
      style={{background:`radial-gradient(ellipse at 12% 12%,${c.glow},transparent 50%),#1e1934`}}>
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:`linear-gradient(135deg,${c.tile}cc,${c.tile}55)`,boxShadow:`0 1px 8px ${c.glow}`}}>
            <Icon size={12} style={{color:c.icon}}/>
          </div>
          <span className="text-[12px] font-semibold text-foreground/85" style={{fontFamily:"'DM Sans',sans-serif"}}>{domain.label}</span>
        </div>
        {size!=="sm" && (
          <div className="flex items-center gap-1.5">
            <div className="w-10 h-[2.5px] rounded-full bg-white/[0.07] overflow-hidden">
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
              <p className="text-[11.5px] text-foreground/80 leading-snug truncate" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.text}</p>
              {size==="xl" && <p className="text-[10px] text-muted-foreground/70 truncate">{item.meta}</p>}
            </div>
            {item.progress>0 && size==="xl" && <Ring progress={item.progress} color={c.light}/>}
          </div>
        ))}
      </div>

      {size!=="sm" && (
        <div className="flex-shrink-0 flex items-center justify-between pt-2 border-t border-white/[0.06]">
          <div className="flex gap-1">
            {domain.sources.slice(0,3).map(s=>(
              <span key={s} className="text-[8px] font-mono text-muted-foreground/35 px-1.5 py-px rounded-md bg-white/[0.03]">{s}</span>
            ))}
          </div>
          <ArrowRight size={10} className="text-muted-foreground/20 group-hover:text-muted-foreground/55 transition-colors"/>
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
    default: "text-muted-foreground/50 hover:text-foreground/80 hover:bg-white/[0.07] hover:border-white/15",
    green:   "text-muted-foreground/50 hover:text-emerald-400 hover:bg-emerald-400/[0.07] hover:border-emerald-400/25",
    red:     "text-muted-foreground/50 hover:text-red-400 hover:bg-red-400/[0.07] hover:border-red-400/20",
    amber:   "text-muted-foreground/50 hover:text-amber-400 hover:bg-amber-400/[0.07] hover:border-amber-400/20",
    violet:  "text-muted-foreground/50 hover:text-primary hover:bg-primary/[0.08] hover:border-primary/25",
  };
  return (
    <button onClick={onClick} title={label}
      className={`w-7 h-7 rounded-lg flex items-center justify-center border border-transparent transition-all flex-shrink-0 ${colors[color]}`}>
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
    <div className="flex-shrink-0 rounded-2xl border border-white/[0.06] px-4 py-3 flex items-center gap-3"
      style={{background:"rgba(255,255,255,0.01)"}}>
      <Check size={12} className="text-emerald-400"/>
      <p className="text-[12px] text-muted-foreground/50" style={{fontFamily:"'DM Sans',sans-serif"}}>All clear — nothing urgent right now</p>
    </div>
  );

  return (
    <div className="flex-shrink-0 flex flex-col gap-1.5">
      {/* Undo toasts */}
      {justDone.filter(id=>done.includes(id)).map(id=>{
        const item = ACTION_QUEUE.find(a=>a.id===id); if(!item) return null;
        return (
          <div key={`undo-${id}`} className="flex items-center gap-3 px-4 py-2.5 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            <Check size={11} className="text-emerald-400 flex-shrink-0"/>
            <p className="text-[11.5px] text-muted-foreground/60 flex-1 truncate" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.text}</p>
            <button onClick={()=>undo(id)} className="flex items-center gap-1 text-[10px] font-mono text-primary/60 hover:text-primary transition-colors flex-shrink-0">
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
              style={{background:`linear-gradient(135deg,${c.tile}cc,${c.tile}44)`,boxShadow:`0 1px 8px ${c.glow}`}}>
              <DomIcon size={12} style={{color:c.icon}}/>
            </div>
            {/* Text */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.dot}`}/>
                <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/45">{t.label}</span>
                {item.type==="proactive" && <Lightbulb size={9} className="text-primary/50"/>}
              </div>
              <p className="text-[12.5px] text-foreground/88 leading-snug truncate" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.text}</p>
              <p className="text-[10.5px] text-muted-foreground/45 mt-0.5 truncate">{item.meta}</p>
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
          className="text-[10.5px] text-muted-foreground/40 font-mono hover:text-muted-foreground/70 transition-colors text-left px-1">
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
  ignore:       { label: "Low",        dot: "bg-muted-foreground/40",                             border: "border-white/[0.06]",  bg: "rgba(255,255,255,0.015)" },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1a1530] p-5 shadow-2xl">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={14} className="text-primary"/>
          <h2 className="text-sm font-semibold tracking-tight font-display">Turn on Voice Drafts</h2>
        </div>
        <p className="text-[12.5px] text-foreground/80 mb-3 leading-relaxed">
          Before NeuralConnexions writes replies in your voice, please read what this involves:
        </p>
        <ul className="text-[12px] text-foreground/75 leading-relaxed space-y-2 mb-4 list-disc pl-4">
          <li>The incoming email's <strong>subject, sender and snippet</strong> are sent to <strong>Cloudflare Workers AI</strong> together with a small style summary of your writing.</li>
          <li>Your <strong>full sent folder is never sent</strong> — only a derived voice profile (sign-off, openers, average sentence length).</li>
          <li>Drafts are saved <strong>encrypted</strong> in your account. <strong>Nothing is sent automatically</strong> — every reply needs your click.</li>
        </ul>
        {err && <p className="text-[11px] text-rose-300/80 mb-2">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] text-muted-foreground/80 hover:bg-white/5 hover:text-foreground disabled:opacity-50">
            Not now
          </button>
          <button onClick={accept} disabled={busy}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-primary/15 text-primary ring-1 ring-primary/30 hover:bg-primary/20 disabled:opacity-50">
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
};

type PrepBlockState =
  | { phase: "idle" }
  | { phase: "blocking" }
  | { phase: "done"; human: string; htmlLink: string }
  | { phase: "error"; reason: "scope" | "no_calendar" | "create_failed"; message: string };

type AssistantQuestion = { id: string; question: string; placeholder: string };

function useDraftReply(item: InboxItem, consented: boolean, onRequestConsent: () => Promise<boolean>) {
  const [phase, setPhase] = useState<"idle" | "analyzing" | "asking" | "generating" | "open" | "sending">("idle");
  const [draft, setDraft] = useState<DraftDisplay | null>(null);
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [questions, setQuestions] = useState<AssistantQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pendingNote, setPendingNote] = useState<string>("");
  // Monotonic request id — every async action increments it. Resolutions
  // whose id no longer matches the current `reqRef` are ignored, so a
  // double-click or rapid skip→submit can't write stale state.
  const reqRef = useRef(0);

  function extractEmail(s: string): string {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim();
  }

  const [prepBlock, setPrepBlock] = useState<PrepBlockState>({ phase: "idle" });
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
        setAnswers((a) => ({ ...a, [questionId]: r.answer }));
        setAvailSuggest({ status: "idle" });
      } else if (r.status === "empty") {
        setAvailSuggest({ status: "empty" });
      } else if (r.status === "no_calendar") {
        setAvailSuggest({ status: "no_calendar" });
      } else {
        setAvailSuggest({ status: "error", message: r.message });
      }
    } catch (e) {
      console.warn("suggestAvailability failed:", e);
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
    try {
      const { draftReply } = await import("@/lib/voice-drafts.functions");
      const d = await draftReply({
        data: { memoryNodeId: item.id, clarifications, assistantNote },
      });
      if (myReq !== reqRef.current) return; // superseded
      setDraft({
        id: d.id,
        body: d.body,
        charsInDraft: d.charsInDraft,
        template: d.template,
        assistantNote: d.assistantNote ?? assistantNote,
        proposedSlots: d.proposedSlots,
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
    setPrepBlock({ phase: "idle" });
    setAvailSuggest({ status: "idle" });
    setPhase("idle");
  }

  const button =
    phase === "analyzing" ? (
      <span className="text-[10.5px] font-mono text-muted-foreground/60 px-2">Reading…</span>
    ) : phase === "generating" ? (
      <span className="text-[10.5px] font-mono text-muted-foreground/60 px-2">Drafting…</span>
    ) : phase === "idle" ? (
      <button onClick={startDraft}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium text-primary/85 hover:bg-primary/10 ring-1 ring-primary/25 transition-colors"
        title="Draft a reply in your voice">
        <Sparkles size={11}/> Draft reply
      </button>
    ) : (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium text-primary/70 ring-1 ring-primary/25">
        <Sparkles size={11}/> {phase === "asking" ? "Quick check" : "Drafted"}
      </span>
    );

  const askingPanel = phase === "asking" ? (
    <div className="w-full mt-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Sparkles size={11} className="text-primary"/>
        <span className="text-[9px] font-mono uppercase tracking-wider text-primary/70">Assistant check-in</span>
        {err && <span className="text-[10px] text-rose-300/80 ml-auto">{err}</span>}
      </div>
      {pendingNote && (
        <p className="text-[12px] text-foreground/75 leading-relaxed" style={{fontFamily:"'DM Sans',sans-serif"}}>
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
                className="bg-transparent border border-white/[0.08] rounded-md px-2 py-1.5 text-[12px] text-foreground/90 placeholder:text-muted-foreground/35 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {prepNeeded && (
                <span className="text-[10px] text-muted-foreground/45 mt-0.5">
                  Answer prep time first to use your calendar.
                </span>
              )}
              {canSuggest && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  {availSuggest.status === "idle" && (
                    <button
                      type="button"
                      onClick={() => suggestAvailabilityFromCalendar(q.id)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-primary/75 hover:bg-primary/10 hover:text-primary"
                    >
                      <CalendarDays size={10}/> Use my calendar
                    </button>
                  )}
                  {availSuggest.status === "loading" && (
                    <span className="text-[10.5px] font-mono text-muted-foreground/60">
                      Checking your calendar…
                    </span>
                  )}
                  {availSuggest.status === "empty" && (
                    <span className="text-[10.5px] text-muted-foreground/60">
                      No free slots in the next week — type your own.
                    </span>
                  )}
                  {availSuggest.status === "no_calendar" && (
                    <span className="text-[10.5px] text-muted-foreground/70 inline-flex items-center gap-1">
                      Calendar not connected.{" "}
                      <Link to="/workspace/connections" className="text-primary/80 hover:text-primary underline-offset-2 hover:underline">
                        Connect →
                      </Link>
                    </span>
                  )}
                  {availSuggest.status === "error" && (
                    <span className="text-[10.5px] text-rose-300/70">
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
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary/20 text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
          <Sparkles size={11}/> Draft with this
        </button>
        <button onClick={skipQuestions} disabled={phase !== "asking"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/70 hover:bg-white/5 hover:text-foreground disabled:opacity-50">
          Skip & draft anyway
        </button>
        <button onClick={dismiss}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/60 hover:bg-white/5 hover:text-foreground ml-auto">
          <X size={11}/> Cancel
        </button>
      </div>
    </div>
  ) : null;

  const panel = (phase === "open" || phase === "sending") ? (
    <div className="w-full mt-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Sparkles size={11} className="text-primary"/>
        <span className="text-[9px] font-mono uppercase tracking-wider text-primary/70">{draft?.template} draft</span>
        {err && <span className="text-[10px] text-rose-300/80 ml-auto">{err}</span>}
      </div>
      {draft?.assistantNote && (
        <div className="rounded-lg border border-primary/15 bg-primary/[0.05] px-2.5 py-2">
          <p className="text-[11.5px] text-foreground/75 leading-relaxed italic" style={{fontFamily:"'DM Sans',sans-serif"}}>
            {draft.assistantNote}
          </p>
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(12, Math.max(4, body.split("\n").length + 1))}
        className="w-full bg-transparent border border-white/[0.06] rounded-lg p-2 text-[12.5px] text-foreground/90 font-sans leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        <button onClick={copyAndMarkSent}
          disabled={phase === "sending" || !body.trim() || copied}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary/20 text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
          <Check size={11}/> {copied ? "Copied & marked sent" : phase === "sending" ? "Saving…" : "Copy reply & mark sent"}
        </button>
        {!inIframe && (
          <a href={gmailUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-white/5 hover:text-foreground">
            <Send size={11}/> Open Gmail
          </a>
        )}
        <a href={mailtoUrl}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-white/5 hover:text-foreground">
          mailto…
        </a>
        {inIframe && copied && (
          <span className="text-[10.5px] text-muted-foreground/60 px-1">
            Paste into Gmail in another tab. (Direct link works in your deployed app, blocked in this preview.)
          </span>
        )}
        <button onClick={regenerate} disabled={phase === "sending"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/80 hover:bg-white/5 hover:text-foreground disabled:opacity-50">
          <RefreshCw size={11}/> Regenerate
        </button>
        <button onClick={dismiss} disabled={phase === "sending"}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground/60 hover:bg-white/5 hover:text-foreground disabled:opacity-50 ml-auto">
          <X size={11}/> Dismiss
        </button>
      </div>
      {/* Prep-block follow-up: only when we have both a meeting slot to anchor
          on AND the user told us how much prep time they want. */}
      {draft?.proposedSlots && draft.proposedSlots.length > 0 && answers.prep_time?.trim() && (
        <div className="border-t border-white/[0.06] pt-2 mt-1 flex items-center gap-2 flex-wrap">
          {prepBlock.phase === "idle" && (
            <button onClick={blockPrepTime}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-primary/85 hover:bg-primary/10 ring-1 ring-primary/25">
              <CalendarDays size={11}/> Block prep time on my calendar
            </button>
          )}
          {prepBlock.phase === "blocking" && (
            <span className="text-[10.5px] font-mono text-muted-foreground/70">Blocking prep time…</span>
          )}
          {prepBlock.phase === "done" && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300/85">
              <Check size={11}/> Prep blocked: {prepBlock.human}
              {prepBlock.htmlLink && (
                <a href={prepBlock.htmlLink} target="_blank" rel="noopener noreferrer"
                  className="text-primary/80 hover:text-primary underline-offset-2 hover:underline">
                  Open in Calendar →
                </a>
              )}
            </span>
          )}
          {prepBlock.phase === "error" && (
            <span className="text-[10.5px] text-rose-300/80 inline-flex items-center gap-1.5">
              {prepBlock.reason === "scope" ? (
                <>Calendar is read-only.{" "}
                  <Link to="/workspace/connections" className="text-primary/80 hover:text-primary underline-offset-2 hover:underline">
                    Reconnect Google Calendar →
                  </Link>
                </>
              ) : prepBlock.reason === "no_calendar" ? (
                <>No calendar connected.{" "}
                  <Link to="/workspace/connections" className="text-primary/80 hover:text-primary underline-offset-2 hover:underline">
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
          style={{background:`linear-gradient(135deg,${c.tile}cc,${c.tile}44)`,boxShadow:`0 1px 8px ${c.glow}`}}>
          <Mail size={12} style={{color:c.icon}}/>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`}/>
            <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/55">{s.label}</span>
            {item.reason && <span className="text-[9px] text-muted-foreground/40 truncate">· {item.reason}</span>}
          </div>
          <p className="text-[12.5px] text-foreground/88 leading-snug truncate" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.subject}</p>
          <p className="text-[10.5px] text-muted-foreground/45 mt-0.5 truncate">{item.from}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
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
        <p className="text-[11.5px] text-rose-300/80">Couldn't load inbox: {error}</p>
        <Link to="/workspace/connections" className="text-[10.5px] text-primary/70 font-mono hover:text-primary">Connect Gmail →</Link>
      </div>
    );
  }
  if (!items) {
    return <div className="flex-shrink-0 rounded-2xl border border-white/[0.06] px-4 py-3 text-[11.5px] text-muted-foreground/50">Loading inbox…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="flex-shrink-0 rounded-2xl border border-white/[0.06] px-4 py-3 flex items-center gap-3">
        <Inbox size={12} className="text-muted-foreground/60"/>
        <p className="text-[12px] text-muted-foreground/60 flex-1" style={{fontFamily:"'DM Sans',sans-serif"}}>No inbox items yet.</p>
        <Link to="/workspace/connections" className="text-[10.5px] text-primary/70 font-mono hover:text-primary whitespace-nowrap">Pull emails →</Link>
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
        <div className="rounded-2xl border border-white/[0.06] px-4 py-3 flex items-center gap-3">
          <Check size={12} className="text-emerald-400"/>
          <p className="text-[12px] text-muted-foreground/60" style={{fontFamily:"'DM Sans',sans-serif"}}>All clear — nothing urgent right now</p>
        </div>
      )}
      {visible.map(item => {
        const s = CAT_STYLE[item.category];
        const draftable = (item.category === "urgent" || item.category === "today")
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
            onMarkDone={() => setDone(d => [...d, item.id])}
            draftable={draftable}
          />
        );
      })}
      {!showLow && low.length > 0 && (
        <button onClick={()=>setShowLow(true)}
          className="text-[10.5px] text-muted-foreground/40 font-mono hover:text-muted-foreground/70 transition-colors text-left px-1">
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

function HomeCanvas({ onDomain, onRunOvernight, onCompose }: {
  onDomain:(id:DomainId)=>void;
  onRunOvernight:(text:string)=>void;
  onCompose:()=>void;
}) {
  const { user } = useAuth();
  const firstName = (user?.user_metadata?.name || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "there").split(" ")[0];
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  const { items: inbox, error: inboxErr } = useInbox();

  // Group live emails by domain → DomainCard items shape
  const liveByDomain = useMemo(() => {
    const groups: Partial<Record<DomainId, Array<{ id:string; text:string; meta:string; urgent:boolean; progress:number }>>> = {};
    (inbox ?? []).filter(i => i.category !== "ignore").forEach(i => {
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
  }, [inbox]);

  // Sort domains by live activity (count), fall back to static
  const sorted = useMemo(() => {
    const arr = Object.values(DOMAINS) as DomainData[];
    return arr.slice().sort((a: DomainData, b: DomainData) => {
      const ca = liveByDomain[a.id]?.length ?? -1;
      const cb = liveByDomain[b.id]?.length ?? -1;
      if (ca !== cb) return cb - ca;
      return b.activity - a.activity;
    });
  }, [liveByDomain]);
  const ids = sorted.map(d => d.id);

  return (
    <div className="flex flex-col p-3 lg:p-4 gap-3">
      {/* Greeting bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 rounded-2xl border border-white/[0.06]"
        style={{background:"radial-gradient(ellipse at 0% 50%,rgba(139,92,246,0.06) 0%,transparent 60%),rgba(30,25,52,0.5)"}}>
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:"#9b6dfa",boxShadow:"0 0 8px rgba(155,109,250,0.7)"}}/>
        <span className="flex-1 text-[13px] text-foreground/80 font-medium" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
          {greet}, {firstName}
        </span>
        <span className="text-[10.5px] text-muted-foreground/40 hidden md:block font-mono">{dateLabel}</span>
      </div>

      {/* Inbox queue (live) */}
      <InboxQueue onCompose={onCompose} items={inbox} error={inboxErr}/>


      {/* Domain bento */}
      <div className="flex-shrink-0 overflow-x-auto">
        <div className="min-w-[580px] min-h-[420px] grid gap-2.5"
          style={{gridTemplateColumns:"repeat(3,1fr)",gridTemplateRows:"1fr 1fr 80px",gridTemplateAreas:`"d0 d0 d1" "d0 d0 d2" "d3 d4 signal"`}}>
          {([0,1,2,3,4] as const).map(i => {
            const id = ids[i] as DomainId | undefined;
            if (!id) return null;
            const live = liveByDomain[id];
            const sizes = ["xl","lg","md","sm","sm"] as const;
            return (
              <div key={id} style={{gridArea:`d${i}`}}>
                <DomainCard domain={DOMAINS[id]} size={sizes[i]} onClick={()=>onDomain(id)}
                  liveItems={live} liveCount={live?.length}/>
              </div>
            );
          })}
          <div style={{gridArea:"signal"}}>
            <div className="h-full rounded-2xl border border-cyan-400/15 flex items-center gap-3 px-4 cursor-default hover:border-cyan-400/30 transition-colors"
              style={{background:"radial-gradient(ellipse at 0% 50%,rgba(6,182,212,0.08) 0%,transparent 65%),rgba(30,25,52,0.5)"}}>
              <TrendingUp size={12} className="text-cyan-400/70 flex-shrink-0"/>
              <div className="flex-1 min-w-0">
                <p className="text-[11.5px] font-semibold text-foreground/80 truncate" style={{fontFamily:"'DM Sans',sans-serif"}}>Data sovereignty thesis</p>
                <p className="text-[9.5px] text-cyan-400/45 truncate font-mono">15 signals · rising</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Domain detail drawer ─────────────────────────────────────────────────────

function DomainDetail({ domainId, onClose }: { domainId:DomainId; onClose:()=>void }) {
  const domain=DOMAINS[domainId]; const c=C[domainId]; const { Icon }=domain;
  const [done, setDone] = useState<number[]>([]);
  return (
    <div className="absolute inset-0 z-20 flex items-stretch justify-end">
      <div className="w-full max-w-[400px] h-full flex flex-col border-l border-border"
        style={{background:"rgba(18,15,30,0.97)",backdropFilter:"blur(20px)"}}>
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border flex-shrink-0">
          <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{background:`linear-gradient(135deg,${c.tile}dd,${c.tile}66)`,boxShadow:`0 1px 10px ${c.glow}`}}>
            <Icon size={13} style={{color:c.icon}}/>
          </div>
          <span className="text-[14px] font-semibold flex-1 text-foreground" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>{domain.label}</span>
          <span className="text-[9px] font-mono px-2 py-px rounded-full border" style={{color:c.hex,borderColor:`${c.hex}40`,background:`${c.hex}14`}}>{domain.weekLabel}</span>
          <button onClick={onClose} className="ml-1 text-muted-foreground hover:text-foreground transition-colors"><X size={14}/></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-2 scrollbar-none">
          <Mono className="block mb-1">This week</Mono>
          {domain.items.filter(i=>!done.includes(i.id)).map(item=>(
            <div key={item.id} className={`group flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-all ${item.urgent?"border-red-400/20 bg-red-400/[0.04]":"border-white/[0.07] bg-white/[0.02] hover:border-white/15"}`}>
              <span className={`mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.urgent?"bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.7)]":c.dot}`}/>
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] text-foreground/85 leading-snug" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.text}</p>
                <p className="text-[10.5px] text-muted-foreground/70 mt-0.5">{item.meta}</p>
              </div>
              {item.progress>0 && <Ring progress={item.progress} color={c.light}/>}
              <button onClick={()=>setDone(d=>[...d,item.id])} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-emerald-400 flex-shrink-0">
                <Check size={12}/>
              </button>
            </div>
          ))}
          {domain.connectionNote && (
            <div className="mt-2 rounded-xl border border-cyan-400/20 px-4 py-3"
              style={{background:"radial-gradient(ellipse at 0% 0%,rgba(6,182,212,0.08) 0%,transparent 65%)"}}>
              <div className="flex items-center gap-1.5 mb-1"><TrendingUp size={10} className="text-cyan-400"/><Mono className="!text-cyan-400/60">Cross-domain</Mono></div>
              <p className="text-[11.5px] text-foreground/65 leading-snug">{domain.connectionNote}</p>
            </div>
          )}
          <div className="mt-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <Mono className="block mb-2">Sources</Mono>
            <div className="flex flex-wrap gap-1.5">
              {domain.sources.map(s=>(
                <span key={s} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-mono text-foreground/50 bg-white/[0.03] border border-white/[0.06]">
                  <span className="w-1 h-1 rounded-full bg-emerald-400/80"/>
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Mind map canvas ──────────────────────────────────────────────────────────

function MindMapCanvas() {
  const [hovered, setHovered] = useState<string|null>(null);
  return (
    <div className="flex-1 relative overflow-hidden p-4">
      <div className="absolute inset-4 rounded-2xl border border-white/[0.07] overflow-hidden"
        style={{background:"radial-gradient(ellipse at 50% 50%,rgba(109,40,217,0.1) 0%,transparent 62%),#130f1e"}}>
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
                  <p className="text-[11px] font-semibold text-cyan-300 whitespace-nowrap" style={{fontFamily:"'DM Sans',sans-serif"}}>{node.label}</p>
                  <p className="text-[9px] text-cyan-400/55 font-mono">{node.sub}</p>
                </div>
              ) : (
                <div className={`px-2.5 py-1.5 rounded-xl border transition-all max-w-[130px] ${c.border}`}
                  style={{background:isHov?`${c.glow.replace(/[\d.]+\)$/,"0.15)")}`:"`rgba(30,25,52,0.85)",backdropFilter:"blur(6px)",boxShadow:isHov?`0 0 14px ${c.glow}`:undefined}}>
                  <p className={`text-[11px] font-medium ${isHov?c.text:"text-foreground/75"} whitespace-nowrap`} style={{fontFamily:"'DM Sans',sans-serif"}}>{node.label}</p>
                  <p className="text-[9px] text-muted-foreground/60 font-mono mt-0.5">{node.sub}</p>
                </div>
              )}
            </div>
          );
        })}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 bg-black/20 rounded-xl px-2.5 py-2 backdrop-blur-sm">
          {DOMAIN_ORDER.map(id=>(
            <div key={id} className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{background:C[id].hex}}/>
              <span className="text-[8.5px] font-mono text-muted-foreground/45 uppercase tracking-wider">{id.slice(0,5)}</span>
            </div>
          ))}
          <div className="border-t border-white/[0.06] pt-1 mt-0.5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400"/>
              <span className="text-[8.5px] font-mono text-muted-foreground/45 uppercase tracking-wider">signal</span>
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
              className={`w-full text-left px-3 py-2 rounded-xl text-[11.5px] transition-all border flex items-center gap-2 ${filter===cat?"bg-primary/10 border-primary/25 text-primary":"border-transparent text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"}`}
              style={{fontFamily:"'DM Sans',sans-serif"}}>
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
                  <div key={item.id} className={`group rounded-xl border px-4 py-3 transition-all ${isWrong?"border-red-500/20 bg-red-500/[0.03] opacity-50":"border-border bg-white/[0.015] hover:border-white/15"}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {item.inferred && <span className="text-[8.5px] font-mono px-1.5 py-px rounded border text-primary/80 bg-primary/10 border-primary/20">Inferred</span>}
                          {isWrong && <span className="text-[8.5px] font-mono px-1.5 py-px rounded border text-red-300 bg-red-500/10 border-red-500/20">Marked wrong</span>}
                        </div>
                        <p className="text-[12.5px] text-foreground/85 leading-snug" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.belief}</p>
                        <p className="text-[10px] font-mono text-muted-foreground/40 mt-1.5">{item.source} · Used {item.lastUsed}</p>
                      </div>
                      <span className={`flex-shrink-0 px-1.5 py-px rounded-full text-[8.5px] font-mono border ${CONF[item.confidence]}`}>{item.confidence}</span>
                    </div>
                    <div className="flex gap-1 mt-2.5 pt-2.5 border-t border-white/[0.05] opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="px-2 py-1 rounded-lg text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-white/[0.05] transition-all">Edit</button>
                      <button onClick={()=>setWrong(w=>w.includes(item.id)?w.filter(x=>x!==item.id):[...w,item.id])} className="px-2 py-1 rounded-lg text-[10px] font-mono text-muted-foreground hover:text-amber-400 hover:bg-amber-500/[0.08] transition-all">{isWrong?"Undo":"Mark wrong"}</button>
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
          <p className="text-[20px] font-semibold text-foreground" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>Emerging signals</p>
          <p className="text-[12.5px] text-muted-foreground mt-0.5" style={{fontFamily:"'DM Sans',sans-serif"}}>Clusters forming across your life before you notice them.</p>
        </div>
        {SIGNALS.map(signal=>{
          const mc=signal.momentum==="rising"?"text-emerald-300 bg-emerald-500/10 border-emerald-500/20":signal.momentum==="fading"?"text-red-300 bg-red-500/10 border-red-500/20":"text-amber-300 bg-amber-500/10 border-amber-500/20";
          return (
            <div key={signal.id} className="rounded-2xl border border-border bg-card/60 p-5">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className={`px-2 py-px rounded-full text-[9px] font-mono border ${mc}`}>{signal.momentum}</span>
                <span className="text-[10px] font-mono text-muted-foreground/50">{signal.evidenceCount} signals</span>
                <div className="flex gap-1 ml-1">
                  {signal.domains.map(d=><span key={d} className="w-2 h-2 rounded-full" style={{background:C[d].hex+"cc"}} title={d}/>)}
                </div>
              </div>
              <p className="text-[13.5px] font-semibold text-foreground/90 mb-1.5" style={{fontFamily:"'DM Sans',sans-serif"}}>{signal.title}</p>
              <p className="text-[12px] text-muted-foreground leading-relaxed mb-4" style={{fontFamily:"'DM Sans',sans-serif"}}>{signal.summary}</p>
              <div className="flex items-center gap-2 pt-3 border-t border-white/[0.06]">
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11.5px] font-medium bg-primary/15 border border-primary/30 text-primary hover:bg-primary/20 transition-all" style={{fontFamily:"'DM Sans',sans-serif"}}>
                  <ArrowRight size={10}/> {signal.suggestedAction}
                </button>
                <button className="px-3 py-1.5 rounded-xl text-[11.5px] text-muted-foreground border border-white/[0.07] hover:border-white/15 hover:text-foreground transition-all ml-auto">Dismiss</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chat tool panel ──────────────────────────────────────────────────────────

const CHAT_MSGS = [
  { role:"user", text:"What are the key items for Q2?" },
  { role:"ai",   text:"3 critical items:\n\n1. Finalise roadmap doc — due Wednesday\n2. Align on mid-market goals with Priya\n3. Partnership terms with Sarah — respond today", sources:["Notion · Q2 Roadmap","Calendar · Today","Gmail thread"] },
  { role:"user", text:"Draft the agenda for the 10am sync" },
  { role:"ai",   text:"Q2 Planning · May 6 · 10:00–10:15\n\n1. Roadmap status — 3 min\n2. Mid-market goals — 5 min\n3. Pricing v3 decision — 4 min\n4. Next actions — 3 min", sources:["Your calendar","Memory · tone profile"] },
];

const AI_MODELS: { id: AIModel; label: string; icon: LucideIcon; color: string }[] = [
  { id:"flash",   label:"FLASH",   icon:Zap,          color:"text-primary bg-primary/15 border-primary/30" },
  { id:"pro",     label:"PRO",     icon:Brain,         color:"text-foreground/70 bg-white/[0.06] border-white/[0.1]"  },
  { id:"gpt5",    label:"GPT-5",   icon:TrendingUp,    color:"text-foreground/70 bg-white/[0.06] border-white/[0.1]"  },
  { id:"private", label:"PRIVATE", icon:Shield,        color:"text-foreground/70 bg-white/[0.06] border-white/[0.1]"  },
];

function ChatPanel({ open, onClose }: { open:boolean; onClose:()=>void }) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<AIModel>("flash");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(()=>{ if(open) setTimeout(()=>inputRef.current?.focus(),80); },[open]);
  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{ if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  if(!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      onClick={onClose}
      style={{background:"rgba(8,4,20,0.82)",backdropFilter:"blur(16px)"}}>
      <div className="w-full max-w-[520px] max-h-[85vh] rounded-3xl border border-white/[0.12] overflow-hidden shadow-2xl flex flex-col"
        style={{background:"rgba(20,16,36,0.98)",boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(155,109,250,0.12)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border flex-shrink-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9566)"}}>
            <MessageCircle size={11} style={{color:"#ddd6fe"}}/>
          </div>
          <span className="text-[13px] font-semibold text-foreground flex-1" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>Chat</span>
          <div className="flex items-center gap-1">
            {["Memory","Inbox","Calendar"].map(ctx=>(
              <span key={ctx} className="px-1.5 py-px rounded-md text-[8.5px] font-mono bg-primary/10 text-primary/70 border border-primary/15">{ctx}</span>
            ))}
          </div>
          <button onClick={onClose} className="ml-2 text-muted-foreground/50 hover:text-foreground transition-colors"><X size={14}/></button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4 scrollbar-none min-h-0">
          {CHAT_MSGS.map((msg,i)=>(
            <div key={i} className={`flex ${msg.role==="user"?"justify-end":"justify-start"}`}>
              {msg.role==="ai" ? (
                <div className="max-w-[92%]">
                  <div className="flex items-start gap-2">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9555)"}}>
                      <Zap size={10} style={{color:"#ddd6fe"}}/>
                    </div>
                    <div className="rounded-2xl rounded-tl-sm px-3.5 py-2.5 border border-border bg-card/80">
                      <p className="text-[12.5px] text-foreground/80 leading-relaxed" style={{fontFamily:"'DM Sans',sans-serif"}} dangerouslySetInnerHTML={{__html:msg.text.replace(/\n/g,"<br/>")}}/>
                    </div>
                  </div>
                  {msg.sources && (
                    <div className="flex gap-1 mt-1.5 ml-8 flex-wrap">
                      {msg.sources.map(s=><span key={s} className="text-[8.5px] font-mono text-muted-foreground/35 px-1.5 py-px rounded-md bg-white/[0.03] border border-white/[0.05]">{s}</span>)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl rounded-tr-sm px-3.5 py-2.5 bg-primary/15 border border-primary/20 max-w-[80%]">
                  <p className="text-[12.5px] text-foreground/85" style={{fontFamily:"'DM Sans',sans-serif"}}>{msg.text}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Input + model selector */}
        <div className="p-4 border-t border-border flex-shrink-0 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 py-2.5">
            <input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)}
              placeholder="Message your assistant…"
              className="flex-1 bg-transparent text-[12.5px] text-foreground/75 placeholder:text-muted-foreground/45 outline-none"
              style={{fontFamily:"'DM Sans',sans-serif"}}/>
            <button className="w-7 h-7 rounded-lg flex items-center justify-center text-primary hover:brightness-110 transition-all flex-shrink-0"
              style={{background:"linear-gradient(135deg,rgba(109,40,217,0.35),rgba(76,29,149,0.2))"}}>
              <Send size={11}/>
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {AI_MODELS.map(m=>{
              const Icon=m.icon;
              const isActive=model===m.id;
              return (
                <button key={m.id} onClick={()=>setModel(m.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono tracking-wide border transition-all ${isActive?m.color:"text-muted-foreground/55 bg-transparent border-white/[0.07] hover:border-white/15 hover:text-foreground/70"}`}>
                  <Icon size={9}/>
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      onClick={onClose}
      style={{background:"rgba(8,4,20,0.82)",backdropFilter:"blur(16px)"}}>
      <div className="w-full max-w-[540px] max-h-[88vh] rounded-3xl border border-white/[0.12] overflow-hidden shadow-2xl flex flex-col"
        style={{background:"rgba(20,16,36,0.98)",boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(155,109,250,0.12)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border flex-shrink-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9566)"}}>
            <PenLine size={11} style={{color:"#ddd6fe"}}/>
          </div>
          <span className="text-[13px] font-semibold text-foreground flex-1" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>Compose</span>
          <button onClick={onClose} className="text-muted-foreground/50 hover:text-foreground transition-colors"><X size={14}/></button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3.5 border-b border-border flex flex-col gap-2.5 flex-shrink-0">
          <input value={title} onChange={e=>setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full bg-transparent text-[12.5px] text-foreground/80 placeholder:text-muted-foreground/40 outline-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2"
            style={{fontFamily:"'DM Sans',sans-serif"}}/>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Mono className="mr-1">Channel</Mono>
            {CHANNELS.map(ch=>(
              <button key={ch} onClick={()=>setChannel(ch)}
                className={`px-2.5 py-1 rounded-full text-[10.5px] border transition-all font-medium ${channel===ch?"text-foreground border-white/20 bg-white/[0.1]":"text-muted-foreground border-transparent hover:border-white/[0.1] hover:text-foreground"}`}
                style={{fontFamily:"'DM Sans',sans-serif"}}>
                {ch}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Mono className="mr-1">Tone</Mono>
            {TONES.map(t=>(
              <button key={t} onClick={()=>setTone(t)}
                className={`px-2.5 py-1 rounded-full text-[10.5px] border transition-all font-medium ${tone===t?"text-foreground border-white/20 bg-white/[0.1]":"text-muted-foreground border-transparent hover:border-white/[0.1] hover:text-foreground"}`}
                style={{fontFamily:"'DM Sans',sans-serif"}}>
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
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] border transition-all ${active?"text-primary border-primary/30 bg-primary/10":"text-muted-foreground border-transparent bg-white/[0.03] hover:border-white/[0.1]"}`}
                  style={{fontFamily:"'DM Sans',sans-serif"}}>
                  <Zap size={8} className={active?"text-primary":"text-muted-foreground"}/>
                  {chip}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 flex flex-col gap-3 overflow-hidden min-h-0">
          {(channel==="Email"||channel==="WhatsApp"||channel==="Slack") && (
            <div className="flex items-center gap-2 pb-2 border-b border-white/[0.06]">
              <Mono className="w-6 flex-shrink-0">To</Mono>
              <input placeholder={channel==="Email"?"sarah@a16z.com":channel==="WhatsApp"?"Maya":"@priya"}
                className="flex-1 bg-transparent text-[12px] text-foreground/75 placeholder:text-muted-foreground/35 outline-none"
                style={{fontFamily:"'DM Sans',sans-serif"}}/>
            </div>
          )}
          <textarea value={body} onChange={e=>setBody(e.target.value)}
            placeholder={placeholder[channel]}
            rows={5}
            className="flex-1 bg-transparent text-[12.5px] text-foreground/75 placeholder:text-muted-foreground/30 outline-none resize-none leading-relaxed scrollbar-none"
            style={{fontFamily:"'DM Sans',sans-serif"}}/>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex-shrink-0 flex items-center gap-2">
          <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[12.5px] font-semibold transition-all"
            style={{background:"linear-gradient(135deg,rgba(109,40,217,0.55),rgba(76,29,149,0.35))",border:"1px solid rgba(155,109,250,0.3)",color:"#ede9fe",fontFamily:"'DM Sans',sans-serif"}}>
            <Send size={12}/> Send
          </button>
          <button className="px-3.5 py-2.5 rounded-xl border border-white/[0.08] text-muted-foreground text-[11.5px] hover:text-foreground hover:border-white/15 transition-all" style={{fontFamily:"'DM Sans',sans-serif"}}>Draft</button>
          <button onClick={onClose} className="px-3.5 py-2.5 rounded-xl text-muted-foreground text-[11.5px] hover:text-foreground transition-all" style={{fontFamily:"'DM Sans',sans-serif"}}>Discard</button>
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
      style={{background:"rgba(8,4,20,0.82)",backdropFilter:"blur(16px)"}}>
      <div className="w-full max-w-[500px] rounded-3xl border border-white/[0.12] overflow-hidden shadow-2xl"
        style={{background:"rgba(20,16,36,0.98)",boxShadow:"0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(155,109,250,0.12)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 p-4 pb-0">
          {([["quick","Quick answer"],["deep","Deep research"]] as [VoiceMode,string][]).map(([v,label])=>(
            <button key={v} onClick={()=>{ setMode(v); setPhase("idle"); setTranscript(""); setResponse(""); }}
              disabled={phase==="listening"||phase==="thinking"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-mono border transition-all ${mode===v
                ? v==="quick"?"text-cyan-300 bg-cyan-400/10 border-cyan-400/25":"text-primary bg-primary/12 border-primary/30"
                : "text-muted-foreground/50 border-transparent hover:border-white/[0.08] hover:text-muted-foreground"}`}>
              {v==="quick"?<Volume2 size={10}/>:<Moon size={10}/>}{label}
            </button>
          ))}
          <button onClick={onClose} className="ml-auto text-muted-foreground/40 hover:text-foreground transition-colors"><X size={13}/></button>
        </div>

        {/* Main area */}
        <div className="px-6 py-6 flex flex-col items-center gap-5">
          {/* Waveform */}
          <div className="flex items-center gap-[3px] h-12">
            {bars.map((h,i)=>(
              <div key={i} className={`w-[3px] rounded-full transition-all ${phase==="listening"?"bg-primary":phase==="thinking"?"bg-primary/40":"bg-white/[0.08]"}`}
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
              <p className="text-[13.5px] text-foreground/85 leading-relaxed" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>
                "{transcript}{phase==="listening"?<span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-middle"/>:""}"
              </p>
            )}
            {phase==="idle" && !transcript && (
              <p className="text-[12px] text-muted-foreground/40 font-mono">
                {mode==="quick" ? "Ask anything — get an instant answer" : "Describe a task — NC researches overnight"}
              </p>
            )}
            {phase==="thinking" && (
              <p className="text-[11.5px] text-primary/60 font-mono animate-pulse">
                {mode==="quick" ? "Thinking…" : "Queuing overnight research…"}
              </p>
            )}
          </div>

          {/* Quick response */}
          {phase==="response" && response && (
            <div className="w-full rounded-2xl border border-primary/20 px-4 py-3.5"
              style={{background:"radial-gradient(ellipse at 0% 0%,rgba(155,109,250,0.08),transparent 60%)"}}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9566)"}}>
                  <Zap size={9} style={{color:"#ddd6fe"}}/>
                </div>
                <Mono className="!text-primary/60">NC · Quick answer</Mono>
              </div>
              <p className="text-[12.5px] text-foreground/80 leading-relaxed" style={{fontFamily:"'DM Sans',sans-serif"}}>{response}</p>
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
              : <Mic size={22} className="text-primary"/>}
          </button>

          <p className="text-[10px] text-muted-foreground/30 font-mono">
            {phase==="idle" ? "tap to speak" : phase==="listening" ? "listening… tap to stop" : phase==="thinking" ? "processing" : "tap to ask again"}
          </p>
        </div>

        {/* Footer hint */}
        {mode==="deep" && phase==="idle" && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-white/[0.05]" style={{background:"rgba(155,109,250,0.03)"}}>
            <Moon size={10} className="text-primary/40 flex-shrink-0"/>
            <p className="text-[10.5px] text-muted-foreground/40 font-mono">NC will run the research while you sleep · results by morning</p>
          </div>
        )}
        {mode==="quick" && phase==="idle" && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-white/[0.05]" style={{background:"rgba(6,182,212,0.02)"}}>
            <Volume2 size={10} className="text-cyan-400/40 flex-shrink-0"/>
            <p className="text-[10.5px] text-muted-foreground/40 font-mono">Grounded in your Memory, calendar, and live signals</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Proactive suggestions ────────────────────────────────────────────────────

const URGENCY_ICON: Record<string, React.ReactNode> = {
  high:   <CalendarDays size={11} className="text-red-400 flex-shrink-0"/>,
  medium: <TrendingUp   size={11} className="text-amber-400 flex-shrink-0"/>,
  low:    <Package      size={11} className="text-emerald-400/70 flex-shrink-0"/>,
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
        <Lightbulb size={10} className="text-primary/60"/>
        <Mono>NC noticed · {visible.length} suggestion{visible.length>1?"s":""}</Mono>
      </div>
      {visible.map(s=>{
        const c = C[s.domain];
        const isOpen = expanded===s.id;
        return (
          <div key={s.id} className="rounded-2xl border overflow-hidden transition-all"
            style={{borderColor:`${c.hex}22`,background:`radial-gradient(ellipse at 0% 0%,${c.glow},transparent 55%),rgba(22,18,36,0.7)`}}>
            <button className="w-full flex items-center gap-3 px-4 py-3 text-left hover:brightness-110 transition-all"
              onClick={()=>setExpanded(isOpen?null:s.id)}>
              <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{background:`linear-gradient(135deg,${c.tile}cc,${c.tile}44)`}}>
                <Lightbulb size={11} style={{color:c.icon}}/>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-semibold text-foreground/88 leading-snug truncate" style={{fontFamily:"'DM Sans',sans-serif"}}>{s.title}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {s.reasoning.map((r,i)=>(
                    <span key={i} className="text-[9px] font-mono text-muted-foreground/40">{i>0?"·":""} {r.source}</span>
                  ))}
                </div>
              </div>
              <ChevronUp size={11} className={`text-muted-foreground/30 flex-shrink-0 transition-transform ${isOpen?"":"rotate-180"}`}/>
              <button onClick={e=>{ e.stopPropagation(); setDismissed(d=>[...d,s.id]); }}
                className="text-muted-foreground/25 hover:text-muted-foreground/60 transition-colors flex-shrink-0 ml-1">
                <X size={11}/>
              </button>
            </button>

            {isOpen && (
              <div className="border-t px-4 py-3.5 flex flex-col gap-3" style={{borderColor:`${c.hex}15`}}>
                <p className="text-[11.5px] text-foreground/65 leading-relaxed" style={{fontFamily:"'DM Sans',sans-serif"}}>{s.body}</p>
                {/* Reasoning chain */}
                <div className="flex flex-col gap-1.5">
                  <Mono className="block mb-0.5">How NC connected this</Mono>
                  {s.reasoning.map((r,i)=>(
                    <div key={i} className="flex items-start gap-2.5">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px]" style={{background:C[r.domain].hex}}/>
                      <div className="flex-1 min-w-0">
                        <span className="text-[9.5px] font-mono text-muted-foreground/40 mr-2">{r.source}</span>
                        <span className="text-[11px] text-foreground/65" style={{fontFamily:"'DM Sans',sans-serif"}}>{r.fact}</span>
                      </div>
                    </div>
                  ))}
                  {s.reasoning.length>1 && (
                    <div className="flex items-center gap-1.5 pl-4 pt-0.5">
                      <div className="h-px flex-1" style={{background:`linear-gradient(90deg,${c.hex}40,transparent)`}}/>
                      <span className="text-[9px] font-mono" style={{color:`${c.hex}80`}}>cross-domain signal</span>
                    </div>
                  )}
                </div>
                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  {s.actionType==="overnight" && (
                    <button onClick={()=>{ onRunOvernight(s.action); setDismissed(d=>[...d,s.id]); }}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11.5px] font-medium transition-all"
                      style={{background:`linear-gradient(135deg,${c.tile}88,${c.tile}44)`,border:`1px solid ${c.hex}35`,color:c.icon,fontFamily:"'DM Sans',sans-serif"}}>
                      <Moon size={11}/> {s.action}
                    </button>
                  )}
                  {s.actionType==="compose" && (
                    <button onClick={()=>{ onCompose(); setDismissed(d=>[...d,s.id]); }}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11.5px] font-medium transition-all"
                      style={{background:`linear-gradient(135deg,${c.tile}88,${c.tile}44)`,border:`1px solid ${c.hex}35`,color:c.icon,fontFamily:"'DM Sans',sans-serif"}}>
                      <PenLine size={11}/> {s.action}
                    </button>
                  )}
                  <button onClick={()=>setDismissed(d=>[...d,s.id])}
                    className="px-3 py-2 rounded-xl text-[11px] text-muted-foreground border border-white/[0.06] hover:border-white/15 hover:text-foreground transition-all" style={{fontFamily:"'DM Sans',sans-serif"}}>
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
        style={{background:"rgba(15,12,26,0.98)",backdropFilter:"blur(20px)"}}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border flex-shrink-0">
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9566)"}}>
            <User size={11} style={{color:"#ddd6fe"}}/>
          </div>
          <div className="flex-1">
            <p className="text-[13.5px] font-semibold text-foreground/90" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>You</p>
            <p className="text-[10px] text-muted-foreground/45 font-mono mt-px">How NC understands your life</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground/50 hover:text-foreground transition-colors"><X size={14}/></button>
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
                    : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]"
                }`}>
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-px transition-colors ${isActive?"bg-primary/20":"bg-white/[0.05] group-hover:bg-white/[0.08]"}`}>
                  <Icon size={14} className={isActive?"text-primary":"text-muted-foreground/60"}/>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className={`text-[13px] font-semibold ${isActive?"text-primary":"text-foreground/80 group-hover:text-foreground"} transition-colors`} style={{fontFamily:"'DM Sans',sans-serif"}}>{item.label}</p>
                    {isActive && <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0"/>}
                  </div>
                  <p className="text-[11px] text-muted-foreground/45 mt-1 leading-snug">{item.description}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-4 border-t border-border">
          <p className="text-[10px] text-muted-foreground/30 font-mono leading-relaxed">NC builds this picture from your Gmail, Calendar, and connected sources. You can correct anything in Memory.</p>
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4" onClick={onClose}
      style={{background:"rgba(10,5,24,0.75)",backdropFilter:"blur(12px)"}}>
      <div className="w-full max-w-[620px] flex flex-col gap-0 rounded-2xl border border-primary/25 overflow-hidden shadow-2xl"
        style={{background:"rgba(22,18,38,0.98)",boxShadow:"0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(155,109,250,0.18)"}}
        onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.07]"
          style={{background:"linear-gradient(90deg,rgba(109,40,217,0.1),transparent)"}}>
          <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{background:"linear-gradient(135deg,#6d28d9cc,#4c1d9566)"}}>
            <Moon size={11} style={{color:"#ddd6fe"}}/>
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-foreground/90" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>Ask NC to work on something overnight</p>
            <p className="text-[10.5px] text-muted-foreground/60 font-mono mt-px">Results delivered by morning · powered by deep research agents</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground/50 hover:text-foreground transition-colors"><X size={13}/></button>
        </div>

        {/* Input */}
        <div className="px-5 py-4">
          <textarea ref={ref} value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter" && (e.metaKey||e.ctrlKey)) submit(); }}
            placeholder="e.g. Find me a dress for Maya's wedding — mid-June, budget £200, not too formal…"
            rows={3}
            className="w-full bg-white/[0.04] border border-white/[0.1] rounded-xl px-4 py-3 text-[13px] text-foreground/80 placeholder:text-muted-foreground/35 outline-none resize-none leading-relaxed scrollbar-none focus:border-primary/40 transition-colors"
            style={{fontFamily:"'DM Sans',sans-serif"}}/>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[10px] text-muted-foreground/35 font-mono">⌘↵ to submit · Esc to close</p>
            <p className="text-[10px] text-muted-foreground/35 font-mono">{input.length > 0 ? `${input.length} chars` : ""}</p>
          </div>
        </div>

        {/* Suggested tasks */}
        <div className="px-5 pb-4 flex flex-col gap-2">
          <Mono className="block mb-1">Try asking</Mono>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {SUGGESTED_TASKS.map(({icon:Icon,text},i)=>(
              <button key={i} onClick={()=>setInput(text)}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:border-primary/25 hover:bg-primary/[0.05] transition-all text-left group">
                <Icon size={11} className="text-muted-foreground/50 group-hover:text-primary/60 flex-shrink-0 transition-colors"/>
                <span className="text-[11.5px] text-muted-foreground/70 group-hover:text-foreground/80 leading-snug transition-colors" style={{fontFamily:"'DM Sans',sans-serif"}}>{text}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-white/[0.06]"
          style={{background:"rgba(255,255,255,0.01)"}}>
          <div className="flex items-center gap-1.5 flex-1">
            {(["Learning","Personal","Professional"] as const).map(d=>{
              const id = d.toLowerCase() as DomainId;
              const c = C[id];
              return (
                <span key={d} className="flex items-center gap-1 px-2 py-px rounded-full text-[9.5px] font-mono border"
                  style={{color:c.hex,borderColor:`${c.hex}30`,background:`${c.hex}10`}}>
                  <span className="w-1 h-1 rounded-full" style={{background:c.hex}}/>{d}
                </span>
              );
            })}
            <span className="text-[9.5px] text-muted-foreground/30 font-mono">NC will route to the right domain</span>
          </div>
          <button onClick={submit} disabled={!input.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-semibold transition-all disabled:opacity-35 disabled:cursor-not-allowed"
            style={{background:"linear-gradient(135deg,rgba(109,40,217,0.6),rgba(76,29,149,0.4))",border:"1px solid rgba(155,109,250,0.35)",color:"#ede9fe",fontFamily:"'DM Sans',sans-serif"}}>
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
    ? <Check size={11} className="text-emerald-400"/>
    : s==="running"
      ? <Loader size={11} className="text-primary animate-spin"/>
      : <Clock size={11} className="text-muted-foreground/50"/>;
  const statusLabel: Record<TaskStatus,string> = { done:"Completed", running:"Running now", queued:"Queued" };
  const statusColor: Record<TaskStatus,string> = {
    done:"text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    running:"text-primary bg-primary/10 border-primary/25",
    queued:"text-muted-foreground bg-white/[0.04] border-white/[0.1]",
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <p className="text-[18px] font-semibold text-foreground" style={{fontFamily:"'Plus Jakarta Sans',sans-serif"}}>Scout</p>
          <p className="text-[12px] text-muted-foreground mt-0.5" style={{fontFamily:"'DM Sans',sans-serif"}}>NC researches while you sleep. Results waiting in the morning.</p>
        </div>
        <button onClick={onNewTask}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-semibold border border-primary/30 text-primary bg-primary/10 hover:bg-primary/15 transition-all"
          style={{fontFamily:"'DM Sans',sans-serif"}}>
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
              <p className="text-[12px] text-foreground/70 flex-1" style={{fontFamily:"'DM Sans',sans-serif"}}>
                1 agent running now · research in progress · results by morning
              </p>
              <Mono>11:58 PM</Mono>
            </div>
          )}

          {tasks.map(task=>{
            const c = C[task.domain];
            const isOpen = expanded===task.id;
            return (
              <div key={task.id} className={`rounded-2xl border transition-all overflow-hidden ${task.status==="done"?"border-border hover:border-white/15":"border-border"}`}
                style={{background:"rgba(30,25,52,0.5)"}}>

                {/* Task header */}
                <button className="w-full flex items-start gap-3 px-5 py-4 text-left"
                  onClick={()=>setExpanded(isOpen?null:task.id)}>
                  <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0 mt-px"
                    style={{background:`linear-gradient(135deg,${c.tile}cc,${c.tile}44)`,boxShadow:`0 1px 8px ${c.glow}`}}>
                    {statusIcon(task.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="text-[13px] font-semibold text-foreground/90" style={{fontFamily:"'DM Sans',sans-serif"}}>{task.title}</p>
                      <span className={`px-1.5 py-px rounded-full text-[8.5px] font-mono border ${statusColor[task.status]}`}>{statusLabel[task.status]}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/60 line-clamp-1">{task.input}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <Mono>{task.createdAt}</Mono>
                      {task.completedAt && <Mono className="!text-emerald-400/50">Done {task.completedAt} · {task.duration}</Mono>}
                    </div>
                  </div>
                  <ChevronRight size={13} className={`text-muted-foreground/30 flex-shrink-0 mt-1 transition-transform ${isOpen?"rotate-90":""}`}/>
                </button>

                {/* Expanded: agent steps + results */}
                {isOpen && (
                  <div className="border-t border-white/[0.06]">
                    {/* Agent steps */}
                    {task.agentSteps && (
                      <div className="px-5 py-4 border-b border-white/[0.05]">
                        <Mono className="block mb-3">Agent steps</Mono>
                        <div className="flex flex-col gap-2">
                          {task.agentSteps.map((step,i)=>(
                            <div key={i} className="flex items-start gap-3">
                              <div className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-px border ${task.status==="done"?"border-emerald-500/30 bg-emerald-500/10":"border-primary/25 bg-primary/8"}`}>
                                {task.status==="done"
                                  ? <Check size={8} className="text-emerald-400"/>
                                  : i===0
                                    ? <Loader size={8} className="text-primary animate-spin"/>
                                    : <span className="w-1 h-1 rounded-full bg-muted-foreground/30"/>}
                              </div>
                              <p className="text-[11.5px] text-foreground/65 leading-snug" style={{fontFamily:"'DM Sans',sans-serif"}}>{step}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Running — progress state */}
                    {task.status==="running" && !task.result && (
                      <div className="px-5 py-4 flex items-center gap-3">
                        <Loader size={12} className="text-primary animate-spin flex-shrink-0"/>
                        <p className="text-[12px] text-muted-foreground" style={{fontFamily:"'DM Sans',sans-serif"}}>Researching across sources — checking back at 6am…</p>
                      </div>
                    )}

                    {/* Results */}
                    {task.result && (
                      <div className="px-5 py-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Sparkles size={11} className="text-primary/70"/>
                          <Mono>Results</Mono>
                        </div>
                        <p className="text-[12px] text-foreground/70 leading-relaxed mb-4" style={{fontFamily:"'DM Sans',sans-serif"}}>{task.result.summary}</p>
                        <div className="flex flex-col gap-2">
                          {task.result.items.map((item,i)=>(
                            <div key={i} className={`rounded-xl border px-4 py-3 flex items-start gap-3 transition-all hover:border-white/15 ${i===0?"border-primary/20 bg-primary/[0.04]":"border-white/[0.06] bg-white/[0.01]"}`}>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <p className="text-[12.5px] font-semibold text-foreground/90" style={{fontFamily:"'DM Sans',sans-serif"}}>{item.name}</p>
                                  {i===0 && <span className="text-[8px] font-mono px-1.5 py-px rounded-full bg-primary/15 text-primary border border-primary/25">Top pick</span>}
                                  <span className="text-[9px] font-mono text-emerald-400/70 ml-auto">{item.match}% match</span>
                                </div>
                                <p className="text-[11px] text-muted-foreground/60 leading-snug mb-1.5">{item.note}</p>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-mono text-muted-foreground/40">{item.source}</span>
                                  <span className="text-[12px] font-semibold" style={{color:C[task.domain].hex}}>{item.price}</span>
                                </div>
                              </div>
                              <button className="flex-shrink-0 text-muted-foreground/30 hover:text-foreground/60 transition-colors mt-px">
                                <ExternalLink size={11}/>
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-white/[0.05]">
                          <button className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[11.5px] font-medium bg-primary/15 border border-primary/25 text-primary hover:bg-primary/20 transition-all" style={{fontFamily:"'DM Sans',sans-serif"}}>
                            <Check size={11}/> Save to {task.domain}
                          </button>
                          <button className="px-3.5 py-2 rounded-xl border border-white/[0.07] text-muted-foreground text-[11.5px] hover:text-foreground hover:border-white/15 transition-all" style={{fontFamily:"'DM Sans',sans-serif"}}>Refine search</button>
                          <button className="px-3.5 py-2 rounded-xl text-muted-foreground text-[11.5px] hover:text-foreground transition-all ml-auto" style={{fontFamily:"'DM Sans',sans-serif"}}>Dismiss</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Empty queue callout */}
          <div className="rounded-2xl border border-dashed border-white/[0.07] px-6 py-8 flex flex-col items-center gap-3 text-center cursor-pointer hover:border-primary/20 transition-colors group" onClick={onNewTask}>
            <div className="w-10 h-10 rounded-xl bg-white/[0.03] group-hover:bg-primary/[0.06] border border-white/[0.06] group-hover:border-primary/20 flex items-center justify-center transition-all">
              <Moon size={16} className="text-muted-foreground/30 group-hover:text-primary/50 transition-colors"/>
            </div>
            <p className="text-[12.5px] text-muted-foreground/50 group-hover:text-muted-foreground/70 transition-colors" style={{fontFamily:"'DM Sans',sans-serif"}}>
              Delegate something to NC before you sleep
            </p>
            <span className="text-[10.5px] text-primary/50 font-mono group-hover:text-primary/70 transition-colors">+ New Scout</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function MainApp() {
  const [mapView,     setMapView]     = useState<MapView|null>(null);
  const [tool,        setTool]        = useState<Tool>(null);
  const [domain,      setDomain]      = useState<DomainId|null>(null);
  const [voiceOpen,   setVoiceOpen]   = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [testOpen,    setTestOpen]    = useState(false);
  const [tasks,       setTasks]       = useState<AgentTask[]>(AGENT_TASKS);

  const handleDomain  = (id: DomainId) => { setDomain(id); setTool(null); setMapView(null); setExploreOpen(false); };
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
    <div className="min-h-[100dvh] w-full overflow-x-hidden bg-background text-foreground" style={{fontFamily:"'DM Sans',sans-serif"}}>
      {/* Ambient */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute top-[-8%] left-[15%] w-[700px] h-[550px] rounded-full" style={{background:"radial-gradient(ellipse,rgba(109,40,217,0.11) 0%,transparent 65%)"}}/>
        <div className="absolute bottom-[-15%] right-[5%] w-[500px] h-[500px] rounded-full" style={{background:"radial-gradient(ellipse,rgba(217,119,6,0.07) 0%,transparent 65%)"}}/>
        <div className="absolute top-[40%] right-[30%] w-[300px] h-[300px] rounded-full" style={{background:"radial-gradient(ellipse,rgba(251,113,133,0.05) 0%,transparent 70%)"}}/>
      </div>

      <div className="relative z-10 flex flex-col min-h-[100dvh]">
        <div className="sticky top-0 z-30 bg-background/80 backdrop-blur-md pt-4 lg:pt-6" style={{paddingTop:"max(env(safe-area-inset-top), 1rem)"}}>
          <TopBar
            mapView={mapView} setMapView={handleMap}
            tool={tool} setTool={setTool}
            onDomain={handleDomain} onVoice={handleVoice} onExplore={handleExplore} onTest={handleTest}
          />
        </div>

        <div className="flex-1 relative flex flex-col" style={{minHeight:"calc(100dvh - 56px)"}}>
          {/* Main canvas */}
          {!mapView && <HomeCanvas onDomain={handleDomain} onRunOvernight={handleSubmitTask} onCompose={()=>setTool("compose")}/>}
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
          {domain && !exploreOpen && <DomainDetail domainId={domain} onClose={()=>setDomain(null)}/>}
        </div>
      </div>

      {/* Modals */}
      <VoiceBar   open={voiceOpen}     onClose={()=>setVoiceOpen(false)} onSubmitTask={handleSubmitTask}/>
      <ChatPanel  open={tool==="chat"}    onClose={()=>setTool(null)}/>
      <ComposePanel open={tool==="compose"} onClose={()=>setTool(null)}/>
      

      <div className="pointer-events-none fixed top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent"/>
    </div>
  );
}

export default MainApp;
