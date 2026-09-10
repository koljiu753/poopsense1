import "./new-record-notice.css";

export interface NewRecordNoticeProps {
  onOpen: () => void;
  onDismiss: () => void;
  memberName: string;
  simulated: boolean;
  urgent?: boolean;
  pendingCount?: number;
  occurredAt?: string;
}

export default function NewRecordNotice({ onOpen, onDismiss, memberName, simulated, urgent = false, pendingCount = 1, occurredAt }: NewRecordNoticeProps) {
  const recordTime = occurredAt ? new Date(occurredAt) : null;
  return (
    <aside className={`new-record-notice${urgent ? " is-urgent" : ""}`} aria-label="新记录提醒">
      <img className="new-record-notice-character" src="/poopsense-mascot-pop-v1.png" alt="" width={56} height={56} />
      <div className="new-record-notice-copy" role={urgent ? "alert" : "status"} aria-live={urgent ? "assertive" : "polite"} aria-atomic="true">
        <strong>{urgent ? "新记录需要优先查看" : "有一条新记录，等你来看"}</strong>
        {urgent && <p className="new-record-notice-safety">请查看这次记录的安全提醒</p>}
        <p>
          <span>{memberName}</span>
          {recordTime && !Number.isNaN(recordTime.getTime()) && <time dateTime={occurredAt}>{recordTime.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}
          <span>{pendingCount} 条待查看</span>
          {urgent && <span className="new-record-notice-priority">优先查看</span>}
          {simulated && <span className="new-record-notice-source">模拟记录</span>}
        </p>
      </div>
      <div className="new-record-notice-actions">
        <button type="button" className="new-record-notice-open" onClick={onOpen}>查看新记录</button>
        <button type="button" className="new-record-notice-dismiss" aria-label="稍后查看，关闭新记录提醒" onClick={onDismiss}>稍后</button>
      </div>
    </aside>
  );
}
