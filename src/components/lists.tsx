import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import {
  getLists,
  saveLists,
  newListId,
  type MailList,
  type Recipient,
} from "@/lib/account";
import { sendEncryptedList, isSendingEnabled, type RecipientSendRow } from "@/lib/sender";

/**
 * Parse the member textarea. A line is:
 *   email
 *   email [@mxid:server]
 *   Name <email>
 *   Name <email> [@mxid:server]
 * The MXID is the recipient's "outside of google" identity — where the
 * decryption key is delivered. No MXID = ciphertext only.
 */
function parseRecipients(text: string): Recipient[] {
  const out: Recipient[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const mxidMatch = /\[(@[^\]]+)\]/.exec(s);
    const rest = s.replace(/\[@[^\]]+\]/, "").trim();
    const mxid = mxidMatch?.[1];
    const angle = /^(.*?)\s*<([^<>]+)>$/.exec(rest);
    const email = angle ? angle[2].trim() : rest;
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) continue;
    out.push({
      email,
      name: angle ? angle[1].trim() || undefined : undefined,
      mxid,
    });
  }
  return out;
}

function formatRecipientLine(r: Recipient): string {
  const base = r.name ? `${r.name} <${r.email}>` : r.email;
  return r.mxid ? `${base} [${r.mxid}]` : base;
}

function ListModal({
  open,
  onClose,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  initial: MailList | null;
  onSave: (list: MailList) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [members, setMembers] = useState(initial?.members.map(formatRecipientLine).join("\n") ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const clean = parseRecipients(members);
    if (!name.trim()) {
      setError("Give the list a name.");
      return;
    }
    if (clean.length === 0) {
      setError("Add at least one member email.");
      return;
    }
    onSave({
      id: initial?.id ?? "",
      name: name.trim(),
      members: clean,
    });
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit list" : "New list"}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">List name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Members, Volunteers" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Members — one per line: <code>email</code>, <code>Name &lt;email&gt;</code>, plus an optional MXID in brackets
          </span>
          <textarea
            value={members}
            onChange={(e) => setMembers(e.target.value)}
            rows={6}
            placeholder={"alice@example.com [@alice:hyphae.social]\nBob <bob@example.com>"}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <p className="text-[10px] text-muted-foreground">
          The MXID is where the decryption key is delivered (E2EE). No MXID = the
          recipient gets ciphertext and can't read it.
        </p>
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" className="bg-seal text-seal-foreground hover:brightness-95">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function SendModal({
  open,
  onClose,
  list,
  from,
}: {
  open: boolean;
  onClose: () => void;
  list: MailList;
  from: string;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [rows, setRows] = useState<RecipientSendRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keyed = list.members.filter((m) => m.mxid?.trim()).length;
  const ciphertextOnly = list.members.length - keyed;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setRows(null);
    try {
      const outcome = await sendEncryptedList({
        from,
        recipients: list.members,
        subject,
        body,
      });
      setResult(
        `Sent ciphertext to ${outcome.total}; key delivered via Matrix to ${outcome.keyed}.`,
      );
      setRows(outcome.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Send to ${list.name}`}>
      <form onSubmit={submit} className="space-y-3 p-5">
        <p className="text-[11px] text-muted-foreground">
          {list.members.length} recipient{list.members.length === 1 ? "" : "s"} ·{" "}
          {keyed} keyed via Matrix · {ciphertextOnly} ciphertext-only · via{" "}
          <span className="font-mono">{from}</span>
        </p>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Subject</span>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Message</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <p className="text-[10px] text-muted-foreground">
          Encrypted on your device. Gmail carries ciphertext only; each keyed
          recipient gets the key in an E2EE Matrix DM.
        </p>
        {result && <div className="rounded border border-seal/30 bg-seal/5 px-3 py-2 text-xs text-seal">{result}</div>}
        {error && <div className="text-xs text-destructive">{error}</div>}
        {rows && rows.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded border border-border/60 bg-surface/40 p-2 text-[11px]">
            {rows.map((r) => (
              <li key={r.email} className="flex items-center gap-2">
                <span className="font-mono">{r.email}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {r.keyViaMatrix ? "🔑 via matrix" : r.ok ? "ciphertext only" : "failed"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          <Button
            type="submit"
            disabled={busy || !isSendingEnabled()}
            className="inline-flex items-center gap-1.5 bg-seal text-seal-foreground hover:brightness-95"
          >
            <Send className="h-3.5 w-3.5" />
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
        {!isSendingEnabled() && (
          <p className="text-[10px] text-muted-foreground">
            Sending is disabled — connect Google first.
          </p>
        )}
      </form>
    </Modal>
  );
}

export function ListsView({ from }: { from: string }) {
  const [lists, setLists] = useState<MailList[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MailList | null>(null);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState<MailList | null>(null);

  const refresh = useCallback(() => {
    void getLists()
      .then(setLists)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function upsert(list: MailList) {
    setError(null);
    const next = list.id
      ? lists.map((l) => (l.id === list.id ? list : l))
      : [...lists, { ...list, id: await newListId() }];
    await saveLists(next);
    setLists(next);
    setEditing(null);
    setCreating(false);
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this list? Its members are not emailed.")) return;
    const next = lists.filter((l) => l.id !== id);
    await saveLists(next);
    setLists(next);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <h1 className="font-display text-xl">Lists</h1>
        <Button
          type="button"
          size="sm"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 bg-seal text-seal-foreground hover:brightness-95"
        >
          <Plus className="h-3.5 w-3.5" /> new list
        </Button>
      </div>
      {error && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-6 py-2 text-xs text-destructive">{error}</div>
      )}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {busy ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : lists.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No lists yet. Create one to start sending.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {lists.map((list) => {
              const keyed = list.members.filter((m) => m.mxid?.trim()).length;
              return (
                <li key={list.id} className="flex items-center gap-3 py-3">
                  <button
                    type="button"
                    onClick={() => setEditing(list)}
                    className="flex min-w-0 flex-1 flex-col text-left hover:underline"
                  >
                    <span className="truncate text-sm font-medium">{list.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {list.members.length} recipient{list.members.length === 1 ? "" : "s"} ·{" "}
                      {keyed} keyed via Matrix · {list.members.length - keyed} ciphertext-only
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSending(list)}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Send className="h-3.5 w-3.5" /> Send
                  </Button>
                  <button
                    type="button"
                    onClick={() => void remove(list.id)}
                    aria-label={`Delete ${list.name}`}
                    className="rounded-full p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(creating || editing) && (
        <ListModal
          open
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          initial={editing}
          onSave={(list) => void upsert(list)}
        />
      )}
      {sending && (
        <SendModal
          open
          onClose={() => setSending(null)}
          list={sending}
          from={from}
        />
      )}
    </div>
  );
}