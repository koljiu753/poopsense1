import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type HouseholdSession, type Member } from "./api";
import RecordObservations from "./RecordObservations";
import RecordSource from "./RecordSource";

export type RecordLookupUpdate = { config: AppConfig; sessionId: string };

export default function RecordLookup({ config, members, onRefreshInbox, updatedRecord }: {
  config: AppConfig; members: Member[]; onRefreshInbox: () => void; updatedRecord?: RecordLookupUpdate | null;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<HouseholdSession | null>(null);
  const [error, setError] = useState("");
  const [loadingId, setLoadingId] = useState("");
  const request = useRef<{ controller: AbortController; version: number; identifier: string } | null>(null);
  const revision = useRef(0);
  const currentIdentifier = useRef("");
  useLayoutEffect(() => {
    revision.current += 1;
    request.current?.controller.abort();
    request.current = null;
    currentIdentifier.current = "";
    setQuery(""); setResult(null); setError(""); setLoadingId("");
    return () => { revision.current += 1; currentIdentifier.current = ""; request.current?.controller.abort(); };
  }, [config]);
  const findRecord = useCallback(async (identifier: string, afterClaim = false) => {
    if (!identifier || request.current?.identifier === identifier && !afterClaim) return;
    // A new search or successful claim supersedes reads begun before it.
    const version = ++revision.current;
    request.current?.controller.abort();
    const controller = new AbortController();
    request.current = { controller, version, identifier };
    currentIdentifier.current = identifier;
    setLoadingId(identifier); setError("");
    setResult(previous => previous?.session_id === identifier ? previous : null);
    try {
      const next = await api.sessionById(config, identifier, controller.signal);
      if (version !== revision.current) return;
      if (next.session_id !== identifier) throw new Error("Unexpected record");
      setResult(next);
    } catch (caught) {
      if (version !== revision.current || controller.signal.aborted) return;
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) setResult(null);
      setError(caught instanceof ApiError && caught.status === 409
        ? "这个记录 ID 对应多个设备，请让采集端使用唯一的 session_id 后再查找。"
        : caught instanceof ApiError && caught.status === 404 ? "当前家庭中未找到这条可查看的记录，请核对上传回执里的 session_id。"
        : caught instanceof ApiError && [401, 403].includes(caught.status) ? "当前家庭授权无法查看这条记录，请核对连接设置。"
        : "暂时没能查到这条记录，请稍后重试。");
    } finally {
      if (request.current?.version === version) request.current = null;
      if (version === revision.current) setLoadingId("");
    }
  }, [config]);
  useLayoutEffect(() => {
    if (updatedRecord?.config !== config || updatedRecord.sessionId !== currentIdentifier.current) return;
    void findRecord(updatedRecord.sessionId, true);
  }, [config, updatedRecord, findRecord]);
  const owner = result?.member_id ? members.find(member => member.member_id === result.member_id) : undefined;
  return <section className="record-search" aria-label="按记录 ID 查找">
    <form onSubmit={event => { event.preventDefault(); void findRecord(query.trim()); }}>
      <label>查找记录 ID<input value={query} onChange={event => setQuery(event.target.value)} placeholder="粘贴上传回执中的 session_id" autoComplete="off" spellCheck={false} /></label>
      <button type="submit" disabled={loadingId === query.trim() || !query.trim()}>{loadingId && loadingId === query.trim() ? "正在查找…" : "查找"}</button>
    </form>
    <p>查询当前家庭有权查看的记录，包含更早的记录。请使用电脑采集程序回执中的同一个 ID。</p>
    <p className="record-lookup-status" role="status">{loadingId
      ? result ? "正在更新，显示上次读取内容。" : "正在查找这条记录…"
      : result ? error ? "显示上次读取的内容。" : "本次读取已完成。" : ""}</p>
    {error && <p role="alert">{result && "更新未完成，以下仍是上次读取的内容。"}{error}</p>}
    {result && <article className="record-search-result" aria-label="记录查找结果">
      <RecordSource record={result} />
      <p>设备：<code>{result.device_id}</code></p>
      <p>{result.assignment_status === "pending_claim" ? "待认领：请在待认领箱选择测试成员并确认归属。" : `已归属：${owner?.display_name ?? result.member_id ?? "当前授权成员"}`}</p>
      {result.assignment_status === "pending_claim" && <button type="button" onClick={onRefreshInbox}>刷新待认领箱</button>}
      <button type="button" aria-disabled={!!loadingId} onClick={() => { if (!loadingId) void findRecord(result.session_id); }}>刷新这条记录</button>
      <RecordObservations record={result} expanded />
    </article>}
  </section>;
}
