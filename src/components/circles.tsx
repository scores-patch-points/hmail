import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { subscribe, getClient } from "@/lib/matrix";
import { newCircle, type Circle } from "@/lib/circles-core";
import {
  loadCircles,
  pingExtension,
  pushToExtension,
  receiveCircles,
  saveCircles,
  shareCircle,
  watchExtension,
  type ExtensionStatus,
} from "@/lib/circles";

function CircleRow({ circle }: { circle: Circle }) {
  const [mxid, setMxid] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      await shareCircle(mxid, circle);
      setMsg({ ok: true, text: `Key sent to ${mxid.trim()} over an encrypted Matrix message.` });
      setMxid("");
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-border/70 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-seal" />
        <span className="font-medium">{circle.name}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{circle.kid}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          value={mxid}
          onChange={(e) => setMxid(e.target.value)}
          placeholder="@them:hyphae.social"
          className="font-mono text-sm"
          disabled={busy}
        />
        <Button type="button" onClick={() => void send()} disabled={busy || !mxid.trim()}>
          {busy ? "Sending…" : "Give access"}
        </Button>
      </div>
      {msg && (
        <p className={`mt-2 text-xs ${msg.ok ? "text-seal" : "text-destructive"}`}>{msg.text}</p>
      )}
    </li>
  );
}

export function CirclesView() {
  const [circles, setCircles] = useState<Record<string, Circle>>(() => loadCircles());
  const [name, setName] = useState("");
  const [ext, setExt] = useState<ExtensionStatus>({ present: false });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checking = useRef(false);

  // Is the extension there? It says hello; we also ask.
  useEffect(() => {
    const off = watchExtension(setExt);
    pingExtension();
    return off;
  }, []);

  // Keep the extension in step with what this account holds.
  useEffect(() => {
    if (ext.present) pushToExtension(Object.values(circles));
  }, [circles, ext.present]);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setError(null);
    try {
      const { added, conflicts } = await receiveCircles();
      if (added.length) {
        setCircles(loadCircles());
        setNote(`Received ${added.length} new circle${added.length === 1 ? "" : "s"}: ${added.map((c) => c.name).join(", ")}.`);
      }
      if (conflicts.length) {
        setError(`Ignored a key for circle ${conflicts.join(", ")}: it doesn't match the one you already hold.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      checking.current = false;
    }
  }, []);

  // Look on open, and again whenever Matrix syncs something new.
  useEffect(() => {
    void check();
    return subscribe(() => void check());
  }, [check]);

  function create() {
    const c = newCircle(name);
    const next = { ...circles, [c.kid]: c };
    saveCircles(next);
    setCircles(next);
    setName("");
    setNote(`Created “${c.name}”. Give people access with their Matrix ID.`);
  }

  const list = Object.values(circles);
  const myId = getClient()?.getUserId();

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-6 py-6">
      <h2 className="font-display text-xl">Circles</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A circle is who can read what you seal. Matrix carries the key to each
        person, encrypted; the Hyphae extension uses it on any site.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-surface/50 px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          Extension:{" "}
          <span className={ext.present ? "font-medium text-seal" : ""}>
            {ext.present ? "connected" : "not detected"}
          </span>
          {ext.present && typeof ext.total === "number" && ` · holds ${ext.total} circle${ext.total === 1 ? "" : "s"}`}
        </span>
        {myId && (
          <span>
            Your Matrix ID: <span className="select-all font-mono text-foreground">{myId}</span>
          </span>
        )}
      </div>

      <div className="mt-5 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New circle, e.g. family"
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create(); }}
        />
        <Button type="button" onClick={create} disabled={!name.trim()}>Create</Button>
        <Button type="button" variant="outline" onClick={() => void check()} title="Check for keys sent to you">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {note && <p className="mt-3 rounded border border-seal/30 bg-seal/5 px-3 py-2 text-xs text-seal">{note}</p>}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <ul className="mt-5 space-y-3">
        {list.length === 0 && (
          <li className="text-sm text-muted-foreground">
            No circles yet. Create one, or ask someone to give you access to theirs.
          </li>
        )}
        {list.map((c) => <CircleRow key={c.kid} circle={c} />)}
      </ul>

      <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
        Anyone you give a circle can read everything ever sealed to it. There is
        no revoke yet: to cut someone off, make a new circle.
      </p>
    </div>
  );
}
