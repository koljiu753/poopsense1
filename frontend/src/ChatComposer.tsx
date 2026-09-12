import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Keep keystrokes local so typing never re-renders reports or long replies. */
export default function ChatComposer({ sending, onSend, onViewReply }: {
  sending: boolean;
  onSend: (text: string) => void;
  onViewReply?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const keyboardSpace = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(120, Math.max(48, field.scrollHeight))}px`;
  }, [draft]);
  useEffect(() => {
    const viewport = window.visualViewport;
    let baseline = window.innerHeight;
    let viewportWidth = window.innerWidth;
    const heightsByWidth = new Map([[viewportWidth, baseline]]);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = viewport?.height ?? window.innerHeight;
        const offset = viewport?.offsetTop ?? 0;
        const focused = document.activeElement === input.current;
        if (window.innerWidth !== viewportWidth) {
          viewportWidth = window.innerWidth;
          baseline = heightsByWidth.get(viewportWidth) ?? window.innerHeight;
        }
        baseline = Math.max(baseline, window.innerHeight);
        if (!focused) baseline = window.innerHeight;
        heightsByWidth.set(viewportWidth, baseline);
        const keyboardOpen = focused && baseline - height > 100;
        const inset = `${Math.max(0, window.innerHeight - height - offset)}px`;
        // The fixed composer moves above an overlay keyboard. Reserve the same
        // extra space in the document so its last reply can still scroll clear.
        for (const element of [form.current, keyboardSpace.current]) {
          if (element && element.style.getPropertyValue("--chat-keyboard-inset") !== inset)
            element.style.setProperty("--chat-keyboard-inset", inset);
        }
        document.body.classList.toggle("chat-keyboard-open", keyboardOpen);
      });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.body.classList.remove("chat-keyboard-open");
    };
  }, []);
  return <><div ref={keyboardSpace} className={`chat-keyboard-space${onViewReply ? " has-reply-shortcut" : ""}`} aria-hidden="true" /><form ref={form} className="chat-composer" onSubmit={event => {
    event.preventDefault();
    if (sending || !draft.trim()) return;
    onSend(draft.trim());
    setDraft("");
  }}>
    {onViewReply ? <button type="button" className="chat-reply-shortcut" onClick={onViewReply}>查看刚收到的回答 ↓</button> : null}
    <label className="sr-only" htmlFor="doctor-message">描述你的情况</label>
    <textarea ref={input} id="doctor-message" rows={1} maxLength={4000} value={draft}
      onChange={event => setDraft(event.target.value)}
      placeholder={sending ? "可以先写下一条问题…" : "说说你的问题…"} />
    <button type="submit" disabled={!draft.trim() || sending}>{sending ? "等待回答" : "发送 →"}</button>
  </form></>;
}

export function ChatWaiting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 10000); return () => clearTimeout(timer); }, []);
  return <div className="chat-waiting" role="status"><span aria-hidden="true" className="chat-waiting-dot" />
    {slow ? "还在等待回答，你可以先阅读前面的内容。" : "正在整理回答…"}
  </div>;
}
