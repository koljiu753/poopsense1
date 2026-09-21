import { useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type HouseholdSession, type Member } from "./api";
import RecordObservations from "./RecordObservations";
import RecordSource from "./RecordSource";

export default function RecordLookup({ config, members, onRefreshInbox }: { config: AppConfig; members: Member[]; onRefreshInbox: () => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<HouseholdSession | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef<{ controller: AbortController; version: number } | null>(null);
  const revision = useRef(0);
  useLayoutEffect(() => {
    revision.current += 1;
    request.current?.controller.abort();
    request.current = null;
    setQuery(""); setResult(null); setError(""); setLoading(false);
    return () => { revision.current += 1; request.current?.controller.abort(); };
  }, [config]);
  async function findRecord(identifier = query.trim()) {
    if (!identifier || request.current) return;
    const version = ++revision.current;
    const controller = new AbortController();
    request.current = { controller, version };
    setLoading(true); setError(""); setResult(null);
    try {
      const next = await api.sessionById(config, identifier, controller.signal);
      if (version !== revision.current) return;
      if (next.session_id !== identifier) throw new Error("Unexpected record");
      setResult(next);
    } catch (caught) {
      if (version !== revision.current || controller.signal.aborted) return;
      setError(caught instanceof ApiError && caught.status === 409
        ? "这个记录 ID 对应多个设备，请让采集端使用唯一的 session_id 后再查找。"
        : caught instanceof ApiError && caught.status === 404 ? "当前家庭中未找到这条可查看的记录，请核对上传回执里的 session_id。"
        : caught instanceof ApiError && [401, 403].includes(caught.status) ? "当前家庭授权无法查看这条记录，请核对连接设置。"
        : "暂时没能查到这条记录，请稍后重试。");
    } finally {
      if (request.current?.version === version) request.current = null;
      if (version === revision.current) setLoading(false);
    }
  }
  const owner = result?.member_id ? members.find(member => member.member_id === result.member_id) : undefined;
  return <section className="record-search" aria-label="按记录 ID 查找">
    <form onSubmit={event => { event.preventDefault(); void findRecord(); }}>
      <label>查找记录 ID<input value={query} onChange={event => setQuery(event.target.value)} placeholder="粘贴上传回执中的 session_id" autoComplete="off" spellCheck={false} /></label>
      <button type="submit" disabled={loading || !query.trim()}>{loading ? "正在查找…" : "查找"}</button>
    </form>
    <p>查询当前家庭有权查看的记录，包含更早的记录。请使用电脑采集程序回执中的同一个 ID。</p>
    {error && <p role="alert">{error}</p>}
    {result && <article className="record-search-result" aria-label="记录查找结果">
      <RecordSource record={result} />
      <p>设备：<code>{result.device_id}</code></p>
      <p>{result.assignment_status === "pending_claim" ? "待认领：请在待认领箱选择测试成员并确认归属。" : `已归属：${owner?.display_name ?? result.member_id ?? "当前授权成员"}`}</p>
      {result.assignment_status === "pending_claim" && <button type="button" onClick={onRefreshInbox}>刷新待认领箱</button>}
      <button type="button" disabled={loading} onClick={() => void findRecord(result.session_id)}>刷新这条记录</button>
      <RecordObservations record={result} expanded />
    </article>}
  </section>;
}
