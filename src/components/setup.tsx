import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { signIn, saveConfig } from "@/lib/account";
import { OWNER } from "@/lib/config";

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Registration not permitted/i.test(msg)) return "hyphae.social isn't accepting new accounts right now.";
  if (/CORS/i.test(msg)) return "The homeserver blocked the connection. Ask its operator to allow CORS for this origin.";
  return msg || "Setup failed.";
}

/**
 * First run — make the app account and log in. Two fields. Connecting Google
 * comes after, inside the app (it's a one-time connection, not a login).
 */
export function Setup({ onDone }: { onDone: (creds: { email: string }) => void }) {
  const [email, setEmail] = useState("");
  const [sitePassword, setSitePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cleanEmail = email.trim();
      if (!/^[^@\s]+@[^@\s]+$/.test(cleanEmail)) throw new Error("Enter your email address.");
      if (sitePassword.length < 8) throw new Error("Your password for this site needs at least 8 characters.");
      await signIn(cleanEmail, sitePassword);
      saveConfig(cleanEmail);
      onDone({ email: cleanEmail });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background paper-grain px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-md border border-border/60 bg-background/80 p-7 shadow-sm"
      >
        <div className="mb-5 flex items-center gap-2">
          <span className="font-display text-2xl italic leading-none text-seal">h</span>
          <span className="font-display text-2xl leading-none">yphae</span>
        </div>
        <p className="mb-5 text-xs text-muted-foreground">
          Make your account — two fields. It is how your circles and keys follow you.
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            your email address
          </span>
          <Input
            type="email"
            autoFocus
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="font-mono text-sm"
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            your password for this site
          </span>
          <Input
            type="password"
            placeholder="8+ characters"
            value={sitePassword}
            onChange={(e) => setSitePassword(e.target.value)}
            disabled={busy}
          />
          <span className="mt-1 block text-[10px] text-muted-foreground">
            the one you'll type to get in each time
          </span>
        </label>

        {error && (
          <div className="mb-4 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating…" : "make account & sign in"}
        </Button>

        <p className="mt-5 text-[10px] leading-relaxed text-muted-foreground">
          Operated by <span className="font-medium">{OWNER}</span>. Keys travel over end-to-end-encrypted Matrix.{" "}
          <a href={`${import.meta.env.BASE_URL}privacy/`} target="_blank" rel="noreferrer" className="underline">
            Privacy
          </a>{" "}
          ·{" "}
          <a href={`${import.meta.env.BASE_URL}terms/`} target="_blank" rel="noreferrer" className="underline">
            Terms
          </a>
        </p>
      </form>
    </div>
  );
}