import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type AppConfig, type InboxItem } from "./api";

type InboxScope = {
  config: AppConfig;
  active: boolean;
  paused: boolean;
  denied: boolean;
  revision: number;
  controller?: AbortController;
  pending?: Promise<void>;
};

/** Household inbox updates never change navigation, members, focus or chat state. */
export default function useClaimInbox(config: AppConfig) {
  const scope = useMemo<InboxScope>(() => ({ config, active: false, paused: false, denied: false, revision: 0 }),
    [config.apiBase, config.householdId, config.householdKey]);
  const [state, setState] = useState<{ scope: InboxScope; items: InboxItem[]; error: string }>({ scope, items: [], error: "" });
  const read = useCallback((manual = false): Promise<void> => {
    if (!scope.active || scope.paused || !manual && (document.hidden || scope.denied)) return Promise.resolve();
    if (scope.pending) return scope.pending;
    if (manual) scope.denied = false;
    const revision = scope.revision;
    const controller = new AbortController();
    scope.controller = controller;
    const request = api.inbox(scope.config, controller.signal).then(items => {
      if (!scope.active || revision !== scope.revision) return;
      setState({ scope, items, error: "" });
    }).catch(caught => {
      if (!scope.active || revision !== scope.revision || controller.signal.aborted) return;
      if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
        scope.denied = true;
        setState({ scope, items: [], error: caught.status === 401 ? "待认领记录的查看身份已失效，请检查家庭连接。" : "" });
        return;
      }
      setState(previous => ({ scope, items: previous.scope === scope ? previous.items : [],
        error: "待认领记录暂未更新，当前列表可能不完整。连接恢复后会继续更新，也可以手动重试。" }));
    }).finally(() => {
      if (scope.pending === request) { scope.pending = undefined; scope.controller = undefined; }
    });
    scope.pending = request;
    return request;
  }, [scope]);
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    scope.active = true;
    void read();
    const timer = window.setInterval(() => { void read(); }, 5000);
    const onVisible = () => { if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      scope.active = false; scope.revision += 1;
      scope.controller?.abort(); scope.pending = undefined;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [scope, read]);

  const beginClaim = useCallback(() => {
    // A read begun before the write must never resurrect an already claimed row.
    scope.revision += 1;
    scope.controller?.abort(); scope.pending = undefined;
    scope.paused = true;
    let finished = false;
    return async (claimedId?: string) => {
      if (finished || !scope.active) return;
      finished = true;
      scope.paused = false;
      if (claimedId) setState(previous => ({ scope, error: "", items: previous.scope === scope
        ? previous.items.filter(item => item.session_id !== claimedId) : [] }));
      await refresh();
    };
  }, [scope, refresh]);
  return { items: state.scope === scope ? state.items : [], error: state.scope === scope ? state.error : "", refresh, beginClaim };
}
