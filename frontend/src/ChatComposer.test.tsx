import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import ChatComposer from "./ChatComposer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps typing local, rejects whitespace submissions and sends trimmed text only on request", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  const parentRender = vi.fn();
  function Parent() {
    parentRender();
    return <ChatComposer sending={false} onSend={onSend} />;
  }
  render(<Parent />);
  const input = screen.getByRole("textbox", { name: "描述你的情况" });
  const send = screen.getByRole("button", { name: "发送 →" });
  expect(send).toBeDisabled();
  await user.type(input, "   {Enter}  ");
  expect(send).toBeDisabled();
  fireEvent.submit(input.closest("form")!);
  expect(onSend).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "  第一行问题{Enter}补充说明  ");
  expect(input).toHaveValue("  第一行问题\n补充说明  ");
  expect(parentRender).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
  await user.click(send);
  expect(onSend).toHaveBeenCalledExactlyOnceWith("第一行问题\n补充说明");
  expect(input).toHaveValue("");
  expect(send).toBeDisabled();
});

it("does not send while an IME commits text or while Enter and Shift+Enter add newlines", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<ChatComposer sending={false} onSend={onSend} />);
  const input = screen.getByRole("textbox", { name: "描述你的情况" });
  await user.click(input);
  fireEvent.compositionStart(input);
  fireEvent.compositionUpdate(input, { data: "zhongwen" });
  fireEvent.change(input, { target: { value: "中文问题" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  fireEvent.keyUp(input, { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  fireEvent.compositionEnd(input, { data: "中文问题" });
  expect(onSend).not.toHaveBeenCalled();
  expect(input).toHaveValue("中文问题");
  await user.keyboard("{End}{Enter}补充{Shift>}{Enter}{/Shift}第三行");
  expect(input).toHaveValue("中文问题\n补充\n第三行");
  expect(onSend).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "发送 →" }));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("中文问题\n补充\n第三行");
});

it("lets the user prepare the next question while waiting and retains it when the reply arrives", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  const { rerender } = render(<ChatComposer sending={false} onSend={onSend} />);
  const input = screen.getByRole("textbox", { name: "描述你的情况" });
  await user.type(input, "第一条问题");
  await user.click(screen.getByRole("button", { name: "发送 →" }));
  rerender(<ChatComposer sending onSend={onSend} />);
  expect(input).toBeEnabled();
  expect(input).toHaveAttribute("placeholder", "可以先写下一条问题…");
  expect(screen.getByRole("button", { name: "等待回答" })).toBeDisabled();
  await user.type(input, "下一条草稿{Enter}继续补充");
  await user.click(screen.getByRole("button", { name: "等待回答" }));
  fireEvent.submit(input.closest("form")!);
  expect(onSend).toHaveBeenCalledExactlyOnceWith("第一条问题");
  expect(input).toHaveValue("下一条草稿\n继续补充");
  rerender(<ChatComposer sending={false} onSend={onSend} />);
  expect(input).toHaveValue("下一条草稿\n继续补充");
  expect(screen.getByRole("button", { name: "发送 →" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "发送 →" }));
  expect(onSend).toHaveBeenNthCalledWith(2, "下一条草稿\n继续补充");
  expect(onSend).toHaveBeenCalledTimes(2);
});

it.each([
  { behavior: "visual viewport shrinks while the layout viewport stays tall", visual: true, layoutShrinks: false, inset: "424px" },
  { behavior: "both visual and layout viewports shrink", visual: true, layoutShrinks: true, inset: "0px" },
  { behavior: "window shrinks without the visualViewport API", visual: false, layoutShrinks: true, inset: "0px" },
])("handles keyboard geometry when $behavior, then removes listeners and queued work", ({ visual, layoutShrinks, inset }) => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0 });
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("visualViewport", visual ? viewport : undefined);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  function flushFrame() {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  function resize(height: number) {
    act(() => {
      viewport.height = height;
      if (layoutShrinks) vi.stubGlobal("innerHeight", height);
      viewport.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    flushFrame();
  }

  const { unmount } = render(<StrictMode><ChatComposer sending={false} onSend={vi.fn()} /></StrictMode>);
  const input = screen.getByRole("textbox", { name: "描述你的情况" });
  const form = input.closest("form")!;
  flushFrame();
  act(() => input.focus());
  flushFrame();
  // A small browser-toolbar change should not hide the navigation as a keyboard.
  resize(790);
  expect(document.body).not.toHaveClass("chat-keyboard-open");
  fireEvent.change(input, { target: { value: "键盘变化时保留的草稿" } });
  resize(420);
  expect(document.body).toHaveClass("chat-keyboard-open");
  expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe(inset);
  expect(input).toHaveFocus();
  expect(input).toHaveValue("键盘变化时保留的草稿");

  if (visual && !layoutShrinks) {
    act(() => {
      viewport.offsetTop = 80;
      viewport.dispatchEvent(new Event("scroll"));
    });
    flushFrame();
    expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe("344px");
  }
  act(() => input.blur());
  flushFrame();
  expect(document.body).not.toHaveClass("chat-keyboard-open");
  viewport.offsetTop = 0;
  resize(844);
  expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe("0px");
  act(() => input.focus());
  resize(420);
  expect(document.body).toHaveClass("chat-keyboard-open");
  act(() => window.dispatchEvent(new Event("resize")));
  expect(frames.size).toBeGreaterThan(0);
  unmount();
  expect(document.body).not.toHaveClass("chat-keyboard-open");
  expect(frames.size).toBe(0);

  requestFrame.mockClear();
  act(() => {
    window.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("focusin"));
    document.dispatchEvent(new Event("focusout"));
  });
  expect(requestFrame).not.toHaveBeenCalled();
});

it("restores navigation after portrait-to-landscape keyboard dismissal while the textarea keeps focus", () => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0 });
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("visualViewport", viewport);
  let queuedFrame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queuedFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => { queuedFrame = undefined; });
  function flushFrame() {
    act(() => {
      const callback = queuedFrame;
      queuedFrame = undefined;
      callback?.(performance.now());
    });
  }
  function resize(width: number, layoutHeight: number, visibleHeight: number) {
    act(() => {
      vi.stubGlobal("innerWidth", width);
      vi.stubGlobal("innerHeight", layoutHeight);
      viewport.width = width;
      viewport.height = visibleHeight;
      window.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("resize"));
    });
    flushFrame();
  }

  render(<ChatComposer sending={false} onSend={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "描述你的情况" });
  const form = input.closest("form")!;
  flushFrame();
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "旋转时仍然保留的草稿" } });
  resize(390, 844, 420);
  expect(document.body).toHaveClass("chat-keyboard-open");
  expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe("424px");

  // Rotate with the keyboard open, then dismiss it without blurring the field.
  resize(844, 390, 220);
  expect(document.body).toHaveClass("chat-keyboard-open");
  expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe("170px");
  resize(844, 390, 390);
  expect(input).toHaveFocus();
  expect(document.body).not.toHaveClass("chat-keyboard-open");
  expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe("0px");

  // Returning to portrait must restore that direction's keyboard baseline too.
  resize(390, 844, 420);
  expect(document.body).toHaveClass("chat-keyboard-open");
  resize(390, 844, 844);
  expect(input).toHaveFocus();
  expect(document.body).not.toHaveClass("chat-keyboard-open");
  expect(form.style.getPropertyValue("--chat-keyboard-inset")).toBe("0px");
  expect(input).toHaveValue("旋转时仍然保留的草稿");
});
