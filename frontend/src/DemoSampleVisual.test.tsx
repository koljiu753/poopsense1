import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DemoSampleVisual from "./DemoSampleVisual";

afterEach(cleanup);
describe("demo observation visuals", () => {
  it.each(["elongated", "compact", "scattered", "irregular"])("reuses the %s artwork independently of health reliability", shape => {
    const { container } = render(<DemoSampleVisual shape={shape} color="red" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", `/poop-shape-${shape}-yellow-v2.webp`);
    expect(container.querySelector("figure")).toHaveAttribute("data-demo-color", "red");
    expect(screen.getByRole("img")).toHaveAccessibleName(/演示样本.*红色/);
    expect(screen.getByRole("img").getAttribute("style")).toContain("filter: url(");
  });
  it.each(["red", "green", "blue", "yellow"])("retains a known %s observation when shape is absent", color => {
    const { container } = render(<DemoSampleVisual color={color} />);
    expect(container.querySelector("figure")).toHaveAttribute("data-demo-shape", "unknown");
    expect(container.querySelector("figure")).toHaveAttribute("data-demo-color", color);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img")).toHaveAccessibleName(/形状未知/);
  });
  it("does not silently substitute yellow or a known shape for unknown values", () => {
    const { container } = render(<DemoSampleVisual shape="toString" color="purple" />);
    expect(container.querySelector("figure")).toHaveAttribute("data-demo-shape", "unknown");
    expect(container.querySelector("figure")).toHaveAttribute("data-demo-color", "unknown");
    expect(screen.getByRole("img")).toHaveAccessibleName("演示样本：形状未知，颜色未知");
  });
  it("keeps tint filter identifiers separate between mounted records", () => {
    const { container } = render(<><DemoSampleVisual shape="compact" color="blue" /><DemoSampleVisual shape="elongated" color="green" /></>);
    const filters = [...container.querySelectorAll("filter")].map(filter => filter.id);
    expect(new Set(filters).size).toBe(2);
  });
});
