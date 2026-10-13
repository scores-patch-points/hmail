import { useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  IS_HOSTED,
  connectGoogle,
  getGmailClientId,
  getGmailSession,
  hasGmailClientId,
  hostedOauthHint,
  oauthFixHint,
  setGmailClientId,
} from "@/lib/gmail-oauth";
import { GOOGLE_LINKS } from "@/lib/config";

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 18.9 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-1.9 13.6-5l-6.5-5.5C29.2 34.9 26.6 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.7 39.7 16.3 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7l6.5 5C33.9 40.7 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

const STEPS = [
  { n: 1, title: "Turn on Gmail", done: "button says Manage", url: GOOGLE_LINKS.enableApi },
  { n: 2, title: "Make your key", done: "you have a Client ID to copy", url: GOOGLE_LINKS.credentials },
  { n: 3, title: "Allow sending", done: "the gmail.send scope is added", url: GOOGLE_LINKS.consent },
];

/**
 * The dead-simple Connect Google flow. No client ID yet (or the last attempt
 * failed) → the 4-step tutorial with deep links and a paste field. Client ID
 * present and working → one real "Continue with Google" button.
 */
export function ConnectGoogle({ onConnected }: { onConnected: (email: string) => void }) {
  const [configured, setConfigured] = useState(hasGmailClientId());
  // A hosted build ships its own verified client ID: there is nothing to set up.
  const [showGuide, setShowGuide] = useState(!IS_HOSTED && !hasGmailClientId());
  const [connected, setConnected] = useState(getGmailSession() !== null);
  const [connectedEmail, setConnectedEmail] = useState(getGmailSession()?.email ?? "");
  const [connecting, setConnecting] = useState(false);
  const [clientId, setClientId] = useState(getGmailClientId());
  const [error, setError] = useState<string | null>(null);

  function saveClientId() {
    if (!/\.apps\.googleusercontent\.com$/.test(clientId.trim())) {
      setError("That doesn't look like a Client ID — it ends in .apps.googleusercontent.com");
      return;
    }
    setGmailClientId(clientId);
    setConfigured(true);
    setShowGuide(false);
    setError(null);
  }

  async function onConnect() {
    setConnecting(true);
    setError(null);
    try {
      const s = await connectGoogle();
      setConnected(true);
      setConnectedEmail(s.email);
      onConnected(s.email);
    } catch (err) {
      if (IS_HOSTED) {
        setError(hostedOauthHint(err));
      } else {
        setError(oauthFixHint(err));
        setShowGuide(true); // self-hosted: fall back to the steps so they can fix it
      }
    } finally {
      setConnecting(false);
    }
  }

  // Connected: show it plainly.
  if (connected) {
    return (
      <div className="rounded-md border border-border/70 p-4">
        <p className="inline-flex items-center gap-1.5 rounded-md bg-selected/60 px-3 py-1.5 text-xs font-medium text-selected-foreground">
          <Check className="h-3.5 w-3.5" /> Gmail connected ({connectedEmail})
        </p>
        <button
          type="button"
          onClick={() => void onConnect()}
          className="mt-2 block text-[11px] text-muted-foreground hover:underline"
        >
          re-connect
        </button>
      </div>
    );
  }

  // Not configured, or the last attempt failed → the guided steps.
  if (showGuide) {
    return (
      <div className="rounded-md border border-border/70 p-4">
        <p className="mb-3 text-xs font-semibold">Set up Google — four steps, once, ever</p>
        <ol className="space-y-2">
          {STEPS.map((s) => (
            <li key={s.n} className="flex items-center justify-between gap-3">
              <span className="text-[11px]">
                <span className="font-semibold">{s.n}. {s.title}</span>
                <span className="text-muted-foreground"> — done when {s.done}</span>
              </span>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-xs text-seal hover:underline"
              >
                open <ExternalLink className="h-3 w-3" />
              </a>
            </li>
          ))}
        </ol>
        <label className="mt-3 block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            4. paste your Client ID
          </span>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="font-mono text-sm"
            placeholder="1234567890-abc.apps.googleusercontent.com"
          />
        </label>
        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
        <Button type="button" onClick={saveClientId} className="mt-2 w-full">
          Save & continue
        </Button>
        {configured && (
          <button
            type="button"
            onClick={() => void onConnect()}
            className="mt-2 block text-[11px] text-muted-foreground hover:underline"
          >
            already saved? try Continue with Google
          </button>
        )}
      </div>
    );
  }

  // Configured → the real OAuth button.
  return (
    <div className="rounded-md border border-border/70 p-4">
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Hyphae Mail asks Google for one permission: to <span className="font-medium text-foreground">send email as you</span>.
        It cannot read, list or delete anything in your mailbox, and the token stays in this tab.{" "}
        <a
          href={`${import.meta.env.BASE_URL}privacy/`}
          target="_blank"
          rel="noreferrer"
          className="text-seal hover:underline"
        >
          Privacy policy
        </a>
      </p>
      <button
        type="button"
        onClick={() => void onConnect()}
        disabled={connecting}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-border/70 bg-white px-4 py-2.5 text-sm font-medium text-foreground shadow-sm transition hover:bg-surface disabled:opacity-60"
      >
        <GoogleG /> {connecting ? "Connecting…" : "Continue with Google"}
      </button>
      {error && (
        <div className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {!IS_HOSTED && (
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className="mt-2 block text-[11px] text-muted-foreground hover:underline"
        >
          show setup steps
        </button>
      )}
    </div>
  );
}