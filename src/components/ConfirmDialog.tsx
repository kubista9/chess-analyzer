import { useEffect, useRef, type ReactNode } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Styles the confirm button as destructive (default true). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A modal confirmation built on <dialog> (focus trap, Escape and backdrop from the browser). */
export function ConfirmDialog({ open, title, children, confirmLabel, danger = true, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="dialog-body">
        <h2 id="confirm-title">{title}</h2>
        <p className="muted">{children}</p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className={`button ${danger ? "button-danger" : "button-primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
