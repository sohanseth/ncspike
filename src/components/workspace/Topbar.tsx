import { Search, Command } from "lucide-react";

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="h-16 shrink-0 border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-30">
      <div className="h-full px-6 lg:px-8 flex items-center gap-6">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 px-3 h-9 rounded-lg border border-border bg-surface text-sm text-muted-foreground w-72">
            <Search className="size-4" />
            <span className="flex-1">Ask NeuralConnexions to do anything…</span>
            <kbd className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary inline-flex items-center gap-1">
              <Command className="size-3" />K
            </kbd>
          </div>
          <div className="size-9 rounded-full bg-secondary border border-border overflow-hidden">
            <img
              src={`https://i.pravatar.cc/64?u=jamie`}
              alt="You"
              className="size-full object-cover"
            />
          </div>
        </div>
      </div>
    </header>
  );
}
