import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, type InboxItem } from "./api";
import useClaimInbox from "./useClaimInbox";

vi.mock("./api", async importOriginal => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { inbox: vi.fn() } };
});
const inbox = vi.mocked(api.inbox);
const config = { apiBase: "", householdId: "test-family", householdKey: "test-only" };
const record: InboxItem = { session_id: "pending_1", received_at: "2026-09-21T10:00:00Z", assignment_version: 1, candidates: [], data_kind: "hardware_test" };
let hidden = false;
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); hidden = false; vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden); inbox.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("polls visible pages, skips overlapping reads, and refreshes immediately when visible again", async () => {
  let finish!: (rows: InboxItem[]) => void;
  inbox.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, unmount } = renderHook(() => useClaimInbox(config));
  expect(inbox).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(inbox).toHaveBeenCalledTimes(1);
  await act(async () => { finish([record]); });
  expect(result.current.items).toEqual([record]);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(inbox).toHaveBeenCalledTimes(2);
  hidden = true;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(20000); });
  expect(inbox).toHaveBeenCalledTimes(2);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(inbox).toHaveBeenCalledTimes(3);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a background read on an initially hidden page", async () => {
  hidden = true;
  renderHook(() => useClaimInbox(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(inbox).not.toHaveBeenCalled();
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(inbox).toHaveBeenCalledTimes(1);
});

it("does not resurrect a claimed record when a pre-claim poll arrives late", async () => {
  inbox.mockResolvedValueOnce([record]);
  const { result } = renderHook(() => useClaimInbox(config));
  await act(async () => {});
  let finishOldRead!: (rows: InboxItem[]) => void;
  inbox.mockImplementationOnce(() => new Promise(resolve => { finishOldRead = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  const oldSignal = inbox.mock.calls[1][1]!;
  let finishClaim!: ReturnType<typeof result.current.beginClaim>;
  act(() => { finishClaim = result.current.beginClaim(); });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(inbox).toHaveBeenCalledTimes(2);
  await act(async () => { await finishClaim(record.session_id); });
  expect(result.current.items).toEqual([]);
  await act(async () => { finishOldRead([record]); });
  expect(result.current.items).toEqual([]);
  expect(result.current.error).toBe("");
  expect(inbox).toHaveBeenCalledTimes(3);
  await act(async () => { await finishClaim(record.session_id); });
  expect(inbox).toHaveBeenCalledTimes(3);
});

it("keeps the previous list and a local error when a refreshed inbox fails", async () => {
  inbox.mockResolvedValueOnce([record]).mockRejectedValueOnce(new Error("private transport details"));
  const { result } = renderHook(() => useClaimInbox(config));
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.items).toEqual([record]);
  expect(result.current.error).toContain("当前列表可能不完整");
  expect(result.current.error).not.toContain("private transport details");
  await act(async () => { await result.current.refresh(); });
  expect(result.current.error).toBe("");
});

it("clears rows and pauses automatic polling after permission denial", async () => {
  inbox.mockResolvedValueOnce([record]).mockRejectedValueOnce(new ApiError(403, "HOUSEHOLD_ROLE_DENIED"));
  const { result } = renderHook(() => useClaimInbox(config));
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.items).toEqual([]);
  expect(result.current.error).toBe("");
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(inbox).toHaveBeenCalledTimes(2);
  await act(async () => { await result.current.refresh(); });
  expect(inbox).toHaveBeenCalledTimes(3);
});

it.each(["household", "credential"])("clears old data and ignores a late read when the %s changes", async kind => {
  inbox.mockResolvedValueOnce([record]);
  const { result, rerender } = renderHook(({ settings }) => useClaimInbox(settings), { initialProps: { settings: config } });
  await act(async () => {});
  expect(result.current.items).toEqual([record]);
  let finishOld!: (rows: InboxItem[]) => void;
  let finishNew!: (rows: InboxItem[]) => void;
  inbox.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  inbox.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  rerender({ settings: { ...config, ...(kind === "household" ? { householdId: "other-test-family" } : { householdKey: "other-test-key" }) } });
  expect(result.current.items).toEqual([]);
  await act(async () => { finishOld([record]); });
  expect(result.current.items).toEqual([]);
  const next = { ...record, session_id: "different-authorized-row" };
  await act(async () => { finishNew([next]); });
  expect(result.current.items).toEqual([next]);
});

it("resumes polling after a failed claim without pretending the row was claimed", async () => {
  inbox.mockResolvedValue([record]);
  const { result } = renderHook(() => useClaimInbox(config));
  await act(async () => {});
  const finish = result.current.beginClaim();
  await act(async () => { await finish(); });
  expect(result.current.items).toEqual([record]);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(inbox).toHaveBeenCalledTimes(3);
});
