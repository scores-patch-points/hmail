import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Render the modal as a bottom sheet on mobile and a centered dialog on desktop. */
  sheet?: boolean;
}

export function Modal({ open, onClose, title, children, className, sheet }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-full bg-card text-card-foreground shadow-xl",
          sheet
            ? "max-h-[90vh] rounded-t-2xl sm:max-w-lg sm:rounded-2xl"
            : "max-h-[90vh] rounded-t-2xl sm:max-w-lg sm:rounded-2xl",
          "flex flex-col",
          className,
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
            <div className="font-medium">{title}</div>
            <button
              type="button"
              aria-label="Close"
              className="rounded-full p-1 text-muted-foreground hover:bg-accent"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
