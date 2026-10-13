import { useState, type FormEvent } from "react";
import { Check, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { changeSitePassword } from "@/lib/account";
import { getGmailSession } from "@/lib/gmail-oauth";
import { ConnectGoogle } from "@/components/connect-google";

export function Settings({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  const [pwdOpen, setPwdOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const connected = getGmailSession() !== null;

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-6 py-6">
      <h1 className="font-display text-xl">Settings</h1>
      <p className="mb-6 text-xs text-muted-foreground">Rarely touched.</p>

      {notice && (
        <div className="mb-4 rounded border border-seal/30 bg-seal/5 px-3 py-2 text-xs text-seal">{notice}</div>
      )}

      <div className="divide-y divide-border rounded-md border border-border/70">
        {/* Connect Google */}
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="font-medium">Connect Google</span>
            {connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-selected/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-selected-foreground">
                <Check className="h-3 w-3" /> connected (send-only)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                not connected
              </span>
            )}
          </div>
          <ConnectGoogle onConnected={() => undefined} />
        </div>

        {/* Account line */}
        <div className="flex items-center justify-between p-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">gmail</div>
            <div className="font-mono text-sm">{email}</div>
          </div>
          <span className="text-[10px] text-muted-foreground">send-only token · in this browser</span>
        </div>

        {/* Site password */}
        <div className="flex items-center justify-between gap-4 p-4">
          <span className="font-medium">Your password</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setPwdOpen(true)}>
            change
          </Button>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={() => void onSignOut()}
        className="mt-6 inline-flex w-fit items-center gap-2 text-destructive"
      >
        <LogOut className="h-3.5 w-3.5" /> Sign out
      </Button>

      {pwdOpen && (
        <PasswordModal
          email={email}
          onClose={() => setPwdOpen(false)}
          onDone={async (current, next) => {
            await changeSitePassword(email, current, next);
            setPwdOpen(false);
            setNotice("Password changed — use it from now on.");
          }}
        />
      )}
    </div>
  );
}

function PasswordModal({
  email,
  onClose,
  onDone,
}: {
  email: string;
  onClose: () => void;
  onDone: (current: string, next: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (next.length < 8) throw new Error("At least 8 characters.");
      if (next !== confirm) throw new Error("The two entries don't match.");
      if (next === current) throw new Error("New password is the same as the old.");
      await onDone(current, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Change your password">
      <form onSubmit={submit} className="space-y-3 p-5">
        <p className="text-[11px] text-muted-foreground">
          The site password is never stored — it derives the Matrix account that
          delivers keys for <span className="font-mono">{email}</span>. Changing
          it rotates that account's password. Share the new one with the other admins.
        </p>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Current</span>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="••••••••••" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">New</span>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="••••••••••" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Confirm new</span>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••••" />
        </label>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy} className="bg-seal text-seal-foreground hover:brightness-95">{busy ? "Saving…" : "Change"}</Button>
        </div>
      </form>
    </Modal>
  );
}