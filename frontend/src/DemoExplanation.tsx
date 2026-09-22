import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AppConfig, type DemoExplanationResult } from "./api";
import ChatMessageContent from "./ChatMessageContent";
import "./demo-explanation.css";

type Operation = "read" | "generate";
type Scope = {
  mounted: boolean;
  revision: number;
  result: DemoExplanationResult | null;
  autoAttempted?: boolean;
  recoverRead?: boolean;
  request?: { kind: Operation; controller: AbortController; revision: number };
};
type ViewState = { scope: Scope; result: DemoExplanationResult | null; operation: Operation | null; error: string };

function requestError(error: unknown, kind: Operation) {
  if (error instanceof ApiError) {
    if ([401, 403].includes(error.status)) return "当前家庭授权无法读取或生成这条解读，请核对连接设置。";
    if (error.status === 404) return "暂时找不到这条解读或对应记录，请重新查找记录。";
    if (error.status === 409) return "这条记录暂时不能生成演示解读，请核对记录与采样类型。";
  }
  return kind === "generate"
    ? "生成请求的结果暂未确认。请先重新读取状态，不要重复提交。"
    : "暂时无法读取解读状态，请稍后重试。已有内容如仍显示，是上次读取的结果。";
}

export default function DemoExplanation({ config, sessionId, active = true, autoGenerate = false, onSettled, onPending, onUnavailable }: {
  config: AppConfig; sessionId: string; active?: boolean; autoGenerate?: boolean;
  onSettled?: (result: DemoExplanationResult) => void;
  onPending?: (sessionId: string) => void;
  onUnavailable?: (sessionId: string, status: number) => void;
}) {
  const scope = useMemo<Scope>(() => ({ mounted: false, revision: 0, result: null }), [config, sessionId]);
  const [state, setState] = useState<ViewState>({ scope, result: null, operation: null, error: "" });
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const pending = useRef(onPending);
  pending.current = onPending;
  const autoMode = useRef(autoGenerate);
  autoMode.current = autoGenerate;
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const update = useCallback((patch: Partial<Omit<ViewState, "scope">>) => {
    if (!scope.mounted) return;
    setState(previous => ({ scope, result: null, operation: null, error: "", ...(previous.scope === scope ? previous : {}), ...patch }));
  }, [scope]);
  const run = useCallback(async (kind: Operation, retry = false) => {
    if (!scope.mounted || scope.request) return;
    if (!active || document.hidden) return;
    const revision = ++scope.revision;
    const controller = new AbortController();
    scope.request = { kind, revision, controller };
    if (kind === "generate") { scope.autoAttempted = true; pending.current?.(sessionId); }
    update({ operation: kind, error: "" });
    try {
      const result = kind === "read"
        ? await api.demoExplanation(config, sessionId, controller.signal)
        : await api.generateDemoExplanation(config, sessionId, retry, controller.signal);
      if (!scope.mounted || revision !== scope.revision) return;
      if (result.session_id !== sessionId || !["not_generated", "generating", "completed", "failed"].includes(result.status)
          || result.status === "completed" && (!result.text?.trim() || !result.provider?.trim() || !result.model?.trim())) throw new Error("Unexpected demo explanation");
      scope.result = result;
      scope.recoverRead = false;
      update({ result, error: "" });
      if (result.status === "completed" || result.status === "failed") settled.current?.(result);
      if (result.status === "generating") pending.current?.(sessionId);
    } catch (error) {
      if (!scope.mounted || revision !== scope.revision || controller.signal.aborted) return;
      if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) {
        scope.result = null;
        scope.recoverRead = false;
        update({ result: null });
        unavailable.current?.(sessionId, error.status);
      } else scope.recoverRead = true;
      update({ error: requestError(error, kind) });
    } finally {
      if (scope.request?.revision === revision) scope.request = undefined;
      if (revision === scope.revision) update({ operation: null });
    }
  }, [active, config, sessionId, scope, update]);
  useLayoutEffect(() => {
    scope.mounted = true;
    return () => {
      scope.mounted = false;
      scope.revision += 1;
      scope.request?.controller.abort();
      scope.request = undefined;
    };
  }, [scope]);
  useEffect(() => {
    if (!active) return;
    const stopRead = () => {
      if (scope.request?.kind !== "read") return;
      scope.revision += 1;
      scope.request.controller.abort();
      scope.request = undefined;
      update({ operation: null });
    };
    const onVisible = () => {
      if (document.hidden) stopRead();
      else void run("read");
    };
    void run("read");
    const timer = window.setInterval(() => {
      if (scope.result?.status === "generating" || autoMode.current && scope.recoverRead) void run("read");
    }, 2000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // Leaving this panel pauses reads; an already submitted generation may finish.
      stopRead();
    };
  }, [active, run, scope, update]);

  const view = state.scope === scope ? state : { result: null, operation: null, error: "" };
  const { result, operation, error } = view;
  useEffect(() => {
    if (!autoGenerate || !active || document.hidden || operation || error || result?.status !== "not_generated" || scope.autoAttempted) return;
    scope.autoAttempted = true;
    void run("generate");
  }, [active, autoGenerate, error, operation, result, run, scope]);
  const generating = result?.status === "generating";
  const canGenerate = result?.status === "not_generated" || result?.status === "failed" && result.retry_allowed;
  const status = operation === "generate" ? "生成请求已发送，正在等待结果。"
    : error ? "状态未能更新。"
    : !result ? operation === "read" ? "正在读取已保存状态…" : "尚未读取解读状态。"
    : result.status === "not_generated" && autoGenerate && scope.autoAttempted ? "已确认尚未生成。可手动尝试，不会自动重复提交。"
    : { not_generated: "尚未生成演示解读。", generating: "演示解读生成中。", completed: "演示解读已完成。", failed: "本次演示解读生成失败。" }[result.status];
  return <section className="demo-explanation" aria-label="AI 演示解读">
    <header><span aria-hidden="true">✦</span><h3>AI 演示解读</h3></header>
    <p className="demo-explanation-boundary">本功能用于卡纸、橡皮泥等演示材料，只解释测量结果，不是健康报告。模板相似度不是准确率，手动采样时长不是如厕时长；停用或缺失的传感器保持未知。</p>
    <p role="status" aria-label="AI 演示解读状态">{status}</p>
    {(generating || operation === "generate") && <p>可以离开这个页面，回来后会读取已保存的状态，不会自动重新生成。</p>}
    {error && <p className="demo-explanation-error" role="alert">{error}</p>}
    {result?.status === "failed" && !error && <p className="demo-explanation-error">{result.error_code === "GENERATION_INTERRUPTED"
      ? "上次生成未能完成。"
      : result.error_message || "这次没有获得可用的模型解读。"}{result.retry_allowed ? "可以手动重试。" : "请稍后重新读取状态。"}</p>}
    {result?.status === "completed" && <div className="demo-explanation-result">
      <p className="demo-explanation-source">本次模型：{result.provider} · {result.model}</p>
      <ChatMessageContent text={result.text!} />
    </div>}
    <div className="demo-explanation-actions">
      {canGenerate && !error && <button className="comic-button" type="button" aria-disabled={!!operation} onClick={() => {
        if (!operation) void run("generate", result?.status === "failed");
      }}>{result?.status === "failed" ? "重试生成" : "生成 AI 演示解读"}</button>}
      <button type="button" aria-disabled={!!operation} onClick={() => { if (!operation) void run("read"); }}>{error ? "重新读取状态" : "刷新解读状态"}</button>
    </div>
  </section>;
}
