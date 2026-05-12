import { Search, LogOut, ExternalLink, Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth-context";
import { webSearch, logOpenedSearchUrl } from "@/lib/search.functions";

type Hit = { title: string; url: string; snippet: string; engine?: string };

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [instance, setInstance] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const runSearch = useServerFn(webSearch);
  const logOpen = useServerFn(logOpenedSearchUrl);

  // Cmd/Ctrl-K focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-away closes the dropdown.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setOpen(true);
    setErrored(false);
    try {
      const res = await runSearch({ data: { query: q } });
      setResults(res.results);
      setInstance(res.instance);
      setErrored(res.results.length === 0);
    } catch {
      setErrored(true);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const openGoogle = () => {
    const q = query.trim();
    if (!q) return;
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    logOpen({ data: { query: q, url } }).catch(() => {});
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onResultClick = (hit: Hit) => {
    logOpen({ data: { query: query.trim(), url: hit.url } }).catch(() => {});
  };

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/auth" });
  };

  return (
    <header className="shrink-0 sticky top-0 z-30 border-b border-border bg-background/40 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
      <div className="h-16 px-6 lg:px-8 flex items-center gap-6">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight font-display truncate">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div ref={wrapRef} className="relative hidden md:block">
            <form
              onSubmit={handleSearch}
              className="flex items-center gap-2 px-3 h-9 rounded-lg glass text-sm w-80 focus-within:ring-1 focus-within:ring-primary/40"
            >
              {loading ? (
                <Loader2 className="size-4 text-muted-foreground animate-spin" />
              ) : (
                <Search className="size-4 text-muted-foreground" />
              )}
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => results.length > 0 && setOpen(true)}
                placeholder="Search the web (private)…"
                aria-label="Private web search"
                className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
              <kbd className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/5 ring-1 ring-white/10 font-mono text-muted-foreground">
                ⌘K
              </kbd>
            </form>

            {open && (
              <div className="absolute right-0 mt-2 w-[28rem] max-h-[28rem] overflow-y-auto rounded-xl glass-elevated ring-1 ring-white/10 shadow-2xl z-40">
                <div className="px-3 py-2 flex items-center justify-between border-b border-white/5 text-[11px] font-mono text-muted-foreground">
                  <span>
                    {loading
                      ? "searching…"
                      : instance
                      ? `via ${new URL(instance).host}`
                      : errored
                      ? "no results"
                      : ""}
                  </span>
                  <button
                    onClick={openGoogle}
                    className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                  >
                    Open on Google <ExternalLink className="size-3" />
                  </button>
                </div>

                {!loading && results.length === 0 && (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    {errored
                      ? "Public SearXNG instances are unreachable. Try Google fallback above."
                      : "Press Enter to search."}
                  </div>
                )}

                <ul className="divide-y divide-white/5">
                  {results.map((hit) => (
                    <li key={hit.url}>
                      <a
                        href={hit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => onResultClick(hit)}
                        className="block px-3 py-2.5 hover:bg-white/5 transition-colors"
                      >
                        <div className="text-sm font-medium truncate text-foreground">
                          {hit.title}
                        </div>
                        <div className="text-[11px] font-mono text-primary/70 truncate">
                          {hit.url}
                        </div>
                        {hit.snippet && (
                          <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                            {hit.snippet}
                          </div>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <button
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="relative size-9 rounded-lg inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/5 ring-1 ring-white/10 transition-colors after:content-[''] after:absolute after:-inset-1 after:md:hidden"
          >
            <LogOut className="size-4" />
          </button>
          <div className="size-9 rounded-full bg-gradient-to-br from-primary to-primary-glow ring-1 ring-white/10 overflow-hidden">
            <img
              src={`https://i.pravatar.cc/64?u=jamie`}
              alt="You"
              className="size-full object-cover mix-blend-luminosity opacity-90"
            />
          </div>
        </div>
      </div>
    </header>
  );
}
