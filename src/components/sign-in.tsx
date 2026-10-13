import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { signIn, loadConfig, getLocalEmail } from "@/lib/account";

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/operation is not permitted|Decryption failed|not allowed|decryption/i.test(msg))
    return "Wrong password.";
  if (/M_FORBIDDEN|403/i.test(msg)) return "Wrong password, or this account doesn't match the password.";
  if (/CORS/i.test(msg)) return "The homeserver blocked the connection. Ask its operator to allow CORS for this origin.";
  return msg || "Sign-in failed.";
}

/**
 * Every visit: the shared site password. The Gmail address is already known
 * locally; only a device that has never run setup types it once (recovery).
 */
export function SignIn({ onDone, onSetup }: {
  onDone: (creds: { email: string }) => void;
  onSetup: () => void;
}) {
  const needsEmail = !getLocalEmail();
  const [email, setEmail] = useState(getLocalEmail() ?? "");
  const [sitePassword, setSitePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const clean = needsEmail ? email.trim() : getLocalEmail() ?? "";
      if (!clean.includes("@")) throw new Error("Enter your Gmail address.");
      await signIn(clean, sitePassword);
      const creds = loadConfig();
      if (!creds || creds.email !== clean) throw new Error("No stored config found for this account.");
      onDone(creds);
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
        className="w-full max-w-sm rounded-md border border-border/60 bg-background/80 p-7 shadow-sm"
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="font-display text-2xl italic leading-none text-seal">h</span>
          <span className="font-display text-2xl leading-none">mail</span>
        </div>
        <p className="mb-6 text-xs text-muted-foreground">
          newsletters · one room is one list
        </p>

        {needsEmail && (
          <label className="mb-3 block">
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Gmail address (first time on this device)
            </span>
            <Input
              type="email"
              placeholder="you@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="font-mono text-sm"
            />
          </label>
        )}

        <label className="mb-4 block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            password
          </span>
          <Input
            type="password"
            autoFocus
            value={sitePassword}
            onChange={(e) => setSitePassword(e.target.value)}
            disabled={busy}
            placeholder="••••••••••"
          />
          <span className="mt-1 block text-[10px] text-muted-foreground">
            shared by the admins — ask the owner for it
          </span>
        </label>

        {error && (
          <div className="mb-4 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <button
          type="button"
          onClick={onSetup}
          className="mt-4 text-[11px] text-muted-foreground hover:underline"
        >
          First time here? Set up Connect Google
        </button>

        <p className="mt-6 text-[10px] leading-relaxed text-muted-foreground">
          Your lists live on hyphae.social; mail goes out through Gmail with a
          send-only token that stays in this tab — no third party, no app password.{" "}
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