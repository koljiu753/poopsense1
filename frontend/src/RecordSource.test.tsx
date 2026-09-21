import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import RecordSource from "./RecordSource";
import type { DataKind } from "./api";

afterEach(cleanup);
it.each([
  [{ data_kind: "hardware_test" }, "硬件上传 · 测试记录"],
  [{ data_kind: "simulated" }, "模拟记录"],
  [{ simulated: true }, "模拟记录"],
  [{ data_kind: "unknown", simulated: false }, null],
  [{ simulated: false }, null],
  [{}, null],
] as [{ data_kind?: DataKind; simulated?: boolean }, string | null][])("shows only supported explicit or legacy simulated provenance for %j", (record, expected) => {
  const { container } = render(<RecordSource record={record} />);
  if (expected) expect(screen.getByText(expected)).toBeVisible();
  else expect(container).toBeEmptyDOMElement();
  expect(container).not.toHaveTextContent("真实检测");
});
