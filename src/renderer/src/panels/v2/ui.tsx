// Small pieces shared by the V2 panels: a modal window, Esc handling and the verbatim git error block.
import { useEffect, useRef, type ReactNode } from "react";
import type { DiffFile } from "../../../../shared/types";
import { errorText, explainGitError } from "./format";

/**
 * Calls `fn` on Escape. Listens in the capture phase and stops the event, so the app's own Escape
 * handler (which closes the plant panel) doesn't also fire. The newest overlay wins.
 */
export function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      // First Esc leaves a text field, the next one closes.
      const t = e.target;
      if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return t.blur();
      ref.current();
    };
    stack.push(onKey);
    const top = (e: KeyboardEvent) => stack[stack.length - 1] === onKey && onKey(e);
    window.addEventListener("keydown", top, true);
    return () => {
      window.removeEventListener("keydown", top, true);
      stack.splice(stack.indexOf(onKey), 1);
    };
  }, []);
}
const stack: ((e: KeyboardEvent) => void)[] = [];

/** A floating pixel window over the garden. */
export function Window({ title, sub, onClose, wide, children, className = "" }: { title: string; sub?: ReactNode; onClose(): void; wide?: boolean; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="modal v2-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`v2-win ${wide ? "v2-win--wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}>
        <header className="v2-win__head">
          <div className="v2-win__titles">
            <h2>{title}</h2>
            {sub && <div className="v2-win__sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** A git/gh failure: one plain sentence, then the output exactly as git printed it. */
export function GitError({ error }: { error: unknown }) {
  const text = errorText(error);
  return (
    <div className="v2-err" role="alert">
      <p>{explainGitError(text)}</p>
      <pre>{text}</pre>
    </div>
  );
}

const LETTER: Record<DiffFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", binary: "B" };

export function StatusLetter({ status }: { status: DiffFile["status"] }) {
  return (
    <span className={`v2-letter v2-letter--${status}`} title={status}>
      {LETTER[status]}
    </span>
  );
}

export function Counts({ ins, del }: { ins: number; del: number }) {
  return (
    <span className="v2-counts">
      <span className="v2-plus">+{ins}</span> <span className="v2-minus">−{del}</span>
    </span>
  );
}
