import { useState } from "react";
import { cn } from "@/lib/utils";
import { CirclesView } from "@/components/circles";
import { Settings } from "@/components/settings";

type Tab = "circles" | "settings";

export function Dashboard({ email, onSignOut }: {
  email: string;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("circles");

  return (
    <div className="flex h-screen flex-col bg-background paper-grain">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border bg-surface/50 px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-2xl italic leading-none text-seal">h</span>
          <span className="font-display text-2xl leading-none">yphae</span>
        </div>
        <nav className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setTab("circles")}
            className={cn("text-sm transition hover:text-foreground", tab === "circles" ? "font-bold text-seal" : "text-muted-foreground")}
          >
            Circles
          </button>
          <button
            type="button"
            onClick={() => setTab("settings")}
            className={cn("text-sm transition hover:text-foreground", tab === "settings" ? "font-bold text-seal" : "text-muted-foreground")}
          >
            Settings
          </button>
        </nav>
      </header>

      {/* Account line */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-background px-6 py-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{email}</span>
        <span className="ml-auto text-[10px]">keys travel over end-to-end-encrypted Matrix</span>
      </div>

      {/* Body */}
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {tab === "circles" ? (
            <CirclesView />
          ) : (
            <Settings email={email} onSignOut={onSignOut} />
          )}
        </div>
      </main>
    </div>
  );
}
