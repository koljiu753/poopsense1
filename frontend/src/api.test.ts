import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

const config = { apiBase: "http://test.invalid", householdId: "test", householdKey: "test-only" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
