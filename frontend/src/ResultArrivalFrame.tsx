import type { ReactNode } from "react";

/** Shared arrival stage; callers supply observation or health-specific copy. */
export default function ResultArrivalFrame({ visual, eyebrow, title, description, status, burst = "新记录", risk, onSkip, className = "" }: {
  visual: ReactNode; eyebrow: string; title: string; description: string; status: string;
  burst?: string; risk?: string; onSkip?: () => void; className?: string;
}) {
  return <section className={`result-arrival ${className}`} data-risk={risk} aria-live="polite">
    <div className="result-burst" aria-hidden="true">{burst}</div>
    {visual}
    <div className="result-arrival-copy">
      <small>{eyebrow}</small><h1>{title}</h1><p>{description}</p><span><i /> {status}</span>
    </div>
    {onSkip && <button onClick={onSkip}>跳过动画</button>}
  </section>;
}
