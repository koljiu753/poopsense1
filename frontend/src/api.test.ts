import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

const config = { apiBase: "http://test.invalid", householdId: "test", householdKey: "test-only" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("reads the latest demo once without a cursor and preserves an explicit zero cursor for new uploads", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], next_after_id: 0, has_more: false }) });
  vi.stubGlobal("fetch", fetcher);
  await api.demoSessions(config, "device/one");
  await api.demoSessions(config, "device/one", 0);
  expect(fetcher.mock.calls[0][0]).toBe("http://test.invalid/api/v1/households/test/devices/device%2Fone/demo-sessions?limit=20");
  expect(fetcher.mock.calls[1][0]).toContain("&after_id=0");
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Household-Key")).toBe("test-only");
  expect(fetcher.mock.calls[0][1].method ?? "GET").toBe("GET");
});

it("allows an obsolete inbox read to be cancelled without retrying", async () => {
  const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const result = api.inbox(config, controller.signal);
  const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("aborts a stalled read and permits a later successful read without automatic retry", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })).mockResolvedValueOnce({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetcher);
  const request = api.members(config);
  const assertion = expect(request).rejects.toMatchObject({ status: 408, message: "REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(20000);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await api.members(config)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a stalled response body as well as the connection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url, init) => Promise.resolve({ ok: true, json: () => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }) })));
  const assertion = expect(api.members(config)).rejects.toMatchObject({ message: "REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(20000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("gives writes longer to finish without silently resubmitting them", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetcher);
  const assertion = expect(api.createMember(config, "测试成员")).rejects.toMatchObject({ message: "REQUEST_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(70000);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
