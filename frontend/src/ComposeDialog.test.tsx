import { StrictMode, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import ComposeDialog from "./ComposeDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Editor() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  return <>
    <button onClick={() => setOpen(true)}>打开发布</button>
    <ComposeDialog open={open} onClose={() => setOpen(false)} title="发布草稿">
      <textarea aria-label="草稿" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </ComposeDialog>
  </>;
}

it("tracks visual viewport resize and pan without resetting the editor, then releases its listeners on close", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  const user = userEvent.setup();
  render(<StrictMode><Editor /></StrictMode>);
  const trigger = screen.getByRole("button", { name: "打开发布" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog");
  const input = screen.getByRole("textbox");
  await user.type(input, "只留在本地的虚构草稿");

  act(() => {
    viewport.height = 420;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(dialog.style.getPropertyValue("--compose-viewport-height")).toBe("420px");
  expect(dialog.style.getPropertyValue("--compose-viewport-bottom")).toBe("424px");
  act(() => {
    viewport.offsetTop = 80;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(dialog.style.getPropertyValue("--compose-viewport-top")).toBe("80px");
  expect(dialog.style.getPropertyValue("--compose-viewport-bottom")).toBe("344px");
  expect(input).toHaveFocus();
  expect(input).toHaveValue("只留在本地的虚构草稿");
  expect(document.body.style.position).toBe("fixed");

  await user.click(screen.getByRole("button", { name: "关闭发布面板" }));
  expect(trigger).toHaveFocus();
  expect(document.body.style.position).toBe("");
  expect(document.documentElement.style.overflow).toBe("");
  const changedAfterClose = vi.spyOn(dialog.style, "setProperty");
  act(() => {
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });
  expect(changedAfterClose).not.toHaveBeenCalled();
  await user.click(trigger);
  expect(screen.getByRole("textbox")).toHaveValue("只留在本地的虚构草稿");
  expect(dialog.style.getPropertyValue("--compose-viewport-height")).toBe("300px");
});

it("cleans up StrictMode open/unmount effects and retains a window-resize fallback without visualViewport", () => {
  vi.stubGlobal("visualViewport", undefined);
  vi.stubGlobal("innerHeight", 740);
  const onClose = vi.fn();
  const { unmount } = render(<StrictMode>
    <ComposeDialog open onClose={onClose} title="发布草稿"><textarea aria-label="草稿" /></ComposeDialog>
  </StrictMode>);
  const dialog = screen.getByRole("dialog");
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(dialog.style.getPropertyValue("--compose-viewport-height")).toBe("740px");
  act(() => {
    vi.stubGlobal("innerHeight", 300);
    window.dispatchEvent(new Event("resize"));
  });
  expect(dialog.style.getPropertyValue("--compose-viewport-height")).toBe("300px");
  unmount();
  const changedAfterUnmount = vi.spyOn(dialog.style, "setProperty");
  window.dispatchEvent(new Event("resize"));
  expect(changedAfterUnmount).not.toHaveBeenCalled();
  expect(document.body.style.position).toBe("");
  expect(document.documentElement.style.overflow).toBe("");
  expect(onClose).not.toHaveBeenCalled();
});
