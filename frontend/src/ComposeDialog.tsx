import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import "./compose-dialog.css";

export interface ComposeDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export default function ComposeDialog({ open, onClose, title, children }: ComposeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const nativeModal = useRef(false);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open) {
      // React can restore its pre-commit focus after cleanup; restore ours after commit.
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus({ preventScroll: true });
      restoreFocusRef.current = null;
      return;
    }
    if (!dialog) return;

    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreFocusRef.current = null;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const body = document.body;
    const root = document.documentElement;
    const bodyProperties = ["overflow", "position", "top", "left", "width", "padding-right"] as const;
    const savedBody = bodyProperties.map((name) => ({
      name,
      value: body.style.getPropertyValue(name),
      priority: body.style.getPropertyPriority(name),
    }));
    const rootOverflow = root.style.getPropertyValue("overflow");
    const rootPriority = root.style.getPropertyPriority("overflow");
    const scrollbarWidth = root.clientWidth > 0 ? window.innerWidth - root.clientWidth : 0;
    const paddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `${-scrollY}px`;
    body.style.left = `${-scrollX}px`;
    body.style.width = "100%";
    if (scrollbarWidth > 0) body.style.paddingRight = `${paddingRight + scrollbarWidth}px`;

    // A software keyboard can shrink only the visual viewport, leaving dvh unchanged.
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const height = viewport?.height || window.innerHeight;
      const top = Math.max(0, viewport?.offsetTop ?? 0);
      const bottom = Math.max(0, window.innerHeight - top - height);
      dialog.style.setProperty("--compose-viewport-top", `${top}px`);
      dialog.style.setProperty("--compose-viewport-bottom", `${bottom}px`);
      dialog.style.setProperty("--compose-viewport-height", `${height}px`);
      const content = dialog.querySelector<HTMLElement>(".compose-dialog-body");
      const focused = document.activeElement;
      if (content && content.clientHeight > 0 && focused instanceof HTMLElement && content.contains(focused)) {
        const visible = content.getBoundingClientRect();
        const field = focused.getBoundingClientRect();
        // Scroll only the form: moving the window would disturb the saved page position.
        if (field.height <= visible.height - 16 && field.bottom > visible.bottom - 8) {
          content.scrollTop += field.bottom - visible.bottom + 8;
        } else if (field.top < visible.top + 8) {
          content.scrollTop -= visible.top + 8 - field.top;
        }
      }
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);

    // jsdom and older DOM implementations can omit showModal entirely.
    nativeModal.current = false;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        nativeModal.current = dialog.open;
      } catch {
        // Keep the controlled panel usable when the native modal API is unavailable.
      }
    }
    if (!nativeModal.current) {
      dialog.setAttribute("open", "");
      dialog.setAttribute("data-modal-fallback", "true");
    }

    const textarea = dialog.querySelector<HTMLTextAreaElement>("textarea:not(:disabled):not([hidden])");
    (textarea ?? titleRef.current)?.focus({ preventScroll: true });
    updateViewport();

    return () => {
      // Do not notify onClose here: StrictMode replays setup/cleanup while still open.
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      ["top", "bottom", "height"].forEach((name) => dialog.style.removeProperty(`--compose-viewport-${name}`));
      if (nativeModal.current && dialog.open && typeof dialog.close === "function") dialog.close();
      dialog.removeAttribute("open");
      dialog.removeAttribute("data-modal-fallback");
      nativeModal.current = false;
      savedBody.forEach(({ name, value, priority }) => {
        if (value) body.style.setProperty(name, value, priority);
        else body.style.removeProperty(name);
      });
      if (rootOverflow) root.style.setProperty("overflow", rootOverflow, rootPriority);
      else root.style.removeProperty("overflow");
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
      restoreFocusRef.current = trigger;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="compose-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
        if (outside || !nativeModal.current) onClose();
      }}
      onKeyDown={(event) => {
        if (!nativeModal.current && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        )].filter((element) => !element.closest("[hidden], [inert]"));
        const first = controls[0];
        const last = controls.at(-1);
        const active = document.activeElement;
        if (!first || !last) {
          event.preventDefault();
          titleRef.current?.focus();
        } else if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="compose-dialog-head">
        <h2 ref={titleRef} id={titleId} tabIndex={-1}>{title}</h2>
        <button type="button" className="compose-dialog-close" aria-label="关闭发布面板" onClick={onClose}>关闭 ×</button>
      </header>
      <div className="compose-dialog-body">{children}</div>
    </dialog>
  );
}
