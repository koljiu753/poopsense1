import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SensorSimulator } from "./SensorSimulator";
import { api } from "./api";

vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(),
  api: { simulationStatus: vi.fn(), simulateSensor: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const config = { apiBase: "", householdId: "hh_001", householdKey: "test" };

it("hides the simulator when the backend disables it", async () => {
  vi.mocked(api.simulationStatus).mockResolvedValue({ enabled: false });
  render(<SensorSimulator config={config} memberId="m_001" onReceived={vi.fn()} />);
  await waitFor(() => expect(api.simulationStatus).toHaveBeenCalled());
  expect(screen.queryByText(/体验一次传感器/)).not.toBeInTheDocument();
});

it("retries the same request after network failure, then delivers the record", async () => {
  vi.mocked(api.simulationStatus).mockResolvedValue({ enabled: true });
  vi.mocked(api.simulateSensor).mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce({ session_id: "sim_1", duplicate: true, assignment_status: "confirmed" });
  const onReceived = vi.fn().mockResolvedValue(undefined);
  render(<SensorSimulator config={config} memberId="m_001" onReceived={onReceived} />);
  const user = userEvent.setup();
  await user.click(await screen.findByText(/体验一次传感器/));
  await user.click(screen.getByRole("button", { name: "开始模拟检测" }));
  await screen.findByText(/本次未完成/);
  await user.click(screen.getByRole("button", { name: "开始模拟检测" }));
  await waitFor(() => expect(onReceived).toHaveBeenCalledWith("sim_1", false));
  const calls = vi.mocked(api.simulateSensor).mock.calls;
  expect(calls[0][1]).toEqual(calls[1][1]);
});
