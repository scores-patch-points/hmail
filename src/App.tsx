import { useEffect, useState } from "react";
import { Setup } from "@/components/setup";
import { SignIn } from "@/components/sign-in";
import { Dashboard } from "@/components/dashboard";
import { hasLocalConfig, resetLocalConfig, signOut } from "@/lib/account";

type View = "loading" | "setup" | "signin" | "app";

function LoadingShell({ label }: { label: string }) {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background paper-grain">
      <div className="text-center">
        <div className="font-display text-4xl italic text-seal">h</div>
        <p className="mt-3 font-display text-sm text-muted-foreground">
          {label}
          <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-seal align-middle" />
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [creds, setCreds] = useState<{ email: string } | null>(null);

  useEffect(() => {
    setView(hasLocalConfig() ? "signin" : "setup");
  }, []);

  async function handleSignOut() {
    await signOut().catch(() => undefined);
    setCreds(null);
    setView("signin");
  }

  if (view === "loading") return <LoadingShell label="Loading" />;
  if (view === "setup") return <Setup onDone={(c) => { setCreds(c); setView("app"); }} />;
  if (view === "signin") return (
    <SignIn
      onDone={(c) => { setCreds(c); setView("app"); }}
      onSetup={() => { resetLocalConfig(); setCreds(null); setView("setup"); }}
    />
  );
  if (view === "app" && creds) return <Dashboard email={creds.email} onSignOut={() => void handleSignOut()} />;
  return <LoadingShell label="Loading" />;
}