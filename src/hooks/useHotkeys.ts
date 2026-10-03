import { useEffect, useRef } from "react";

/**
 * Page keyboard shortcuts, e.g. { h: hint, f: flip, Enter: next, ArrowLeft: back }. Keys are
 * KeyboardEvent.key values (letters lower-case). Ignored while typing in a field, inside a dialog,
 * or with a modifier key held.
 */
export function useHotkeys(bindings: Record<string, (() => void) | undefined | false>): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable='true'], dialog") || target.isContentEditable)) {
        return;
      }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const action = ref.current[key];
      if (action) {
        // Enter on a focused button already activates it.
        if (key === "Enter" && target?.closest("button, a")) {
          return;
        }
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
