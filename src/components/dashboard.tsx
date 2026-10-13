import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ListsView } from "@/components/lists";
import { CirclesView } from "@/components/circles";
import { Settings } from "@/components/settings";
import { ConnectGoogle } from "@/components/connect-google";
import { getGmailSession } from "@/lib/gmail-oauth";

type Tab = "lists" | "circles" | "settings";

export function Dashboard({ email, onSignOut }: {
  email: string;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("lists");
  const [gmailConnected, setGmailConnected] = useState(getGmailSession() !== null);

  return (
    <div className="flex h-screen flex-col bg-background paper-grain">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border bg-surface/50 px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-2xl italic leading-none text-seal">H</span>
          <span className="font-display text-2xl leading-none">yphae Mail</span>
        </div>
        <nav className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setTab("lists")}
            className={cn("text-sm transition hover:text-foreground", tab === "lists" ? "font-bold text-seal" : "text-muted-foreground")}
          >
            Lists
          </button>
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

      {/* Connected status */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-background px-6 py-2 text-[11px] text-muted-foreground">
        {gmailConnected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-selected/60 px-2 py-0.5 font-medium uppercase tracking-wider text-selected-foreground">
            <Check className="h-3 w-3" /> gmail connected
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium uppercase tracking-wider text-muted-foreground">
            gmail not connected
          </span>
        )}
        <span className="font-mono">({email})</span>
        <span className="ml-auto text-[10px]">send-only token · no third party · keys via Matrix</span>
      </div>

      {/* Body */}
      <main className="flex min-h-0 flex-1 flex-col">
        {!gmailConnected && (
          <div className="shrink-0 border-b border-border/60 bg-surface/30 px-6 py-4">
            <div className="mx-auto max-w-2xl">
              <p className="mb-2 text-sm font-semibold">Connect Google to send</p>
              <ConnectGoogle onConnected={() => setGmailConnected(true)} />
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tab === "lists" ? (
            <ListsView from={email} />
          ) : tab === "circles" ? (
            <CirclesView />
          ) : (
            <Settings email={email} onSignOut={onSignOut} />
          )}
        </div>
      </main>
    </div>
  );
}