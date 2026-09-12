import { cleanup, render, screen, within } from "@testing-library/react";
import { Lexer } from "marked";
import { afterEach, expect, it, vi } from "vitest";
import ChatMessageContent from "./ChatMessageContent";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("separates reply paragraphs and line breaks, with semantic emphasis, lists and small headings", () => {
  const { container } = render(<ChatMessageContent text={[
    "# 先看重点", "", "第一行说明", "第二行保留换行，**重要内容**和*补充说明*。", "",
    "3. 第一项建议", "4. 第二项建议", "   - 保留子项", "", "## 安全提醒", "",
    "> **如果明显不适，请及时就医。**", "", "结尾提醒不得省略。",
  ].join("\n")} />);
  expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "先看重点", level: 3 })).toBeInTheDocument();
  expect(screen.getByText("重要内容").tagName).toBe("STRONG");
  expect(screen.getByText("补充说明").tagName).toBe("EM");
  expect(container.querySelector(".chat-paragraph br")).toBeInTheDocument();
  expect(container.querySelector("ol")).toHaveAttribute("start", "3");
  expect(within(container.querySelector("ol")!).getAllByRole("listitem")).toHaveLength(3);
  expect(container.querySelector("blockquote")).toHaveTextContent("如果明显不适，请及时就医。");
  expect(screen.getByText("结尾提醒不得省略。").tagName).toBe("P");
});

it("keeps code literal and table cells intact in a labelled, keyboard-scrollable region", () => {
  const { container } = render(<ChatMessageContent text={[
    "使用 `x < y && ready` 查看示例。", "", "```html", "<script>不要执行</script>", "  保留缩进", "```", "",
    "| 观察 | 提醒 |", "| --- | --- |", "| 偏干 | **不要忽略持续不适** |", "| 信息不足 | 不据此诊断 |",
  ].join("\n")} />);
  expect(screen.getByText("x < y && ready").tagName).toBe("CODE");
  const code = screen.getByLabelText("代码");
  expect(code).toHaveAttribute("tabindex", "0");
  expect(code.textContent).toBe("<script>不要执行</script>\n  保留缩进");
  expect(container.querySelector("script")).not.toBeInTheDocument();
  const region = screen.getByRole("region", { name: "回答中的表格，可横向滚动" });
  expect(region).toHaveAttribute("tabindex", "0");
  expect(within(region).getAllByRole("columnheader")).toHaveLength(2);
  expect(within(region).getAllByRole("cell")).toHaveLength(4);
  expect(within(region).getByText("不要忽略持续不适").tagName).toBe("STRONG");
});

it("renders hostile HTML and image syntax as text without executing or loading anything", () => {
  const unsafe = '<img src="https://example.com/track" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<iframe srcdoc="unsafe"></iframe>\n\n![不可忽略的提醒](https://example.com/private.png)\n\n<!-- 如果持续不适请就医 -->';
  const { container } = render(<ChatMessageContent text={unsafe} />);
  expect(container.querySelector("img, script, iframe, style, object, embed")).toBeNull();
  expect(container).toHaveTextContent('<script>alert(2)</script>');
  expect(container).toHaveTextContent("不可忽略的提醒");
  expect(container).toHaveTextContent("如果持续不适请就医");
  expect(container.querySelector("[onerror], [srcdoc]")).toBeNull();
});

it("permits only complete HTTP(S) links and keeps rejected link text visible", () => {
  const { container } = render(<ChatMessageContent text={[
    "[参考](https://example.com/guide)",
    "[普通网页](http://example.com/help)",
    "[不要忽略红线](javascript:alert%281%29)",
    "[实体协议](javascript&#58;alert%281%29)",
    "[大小写协议](JaVaScRiPt:alert%281%29)",
    "[数据链接](data:text/html,test)",
    "[站内操作](/api/v1/execute)",
    "[协议相对](//example.com/path)",
  ].join("\n\n")} />);
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "参考" })).toHaveAttribute("href", "https://example.com/guide");
  expect(screen.getByRole("link", { name: "参考" })).toHaveAttribute("rel", "noopener noreferrer");
  for (const label of ["不要忽略红线", "实体协议", "大小写协议", "数据链接", "站内操作", "协议相对"]) {
    expect(container).toHaveTextContent(label);
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
});

it("does not reparse unchanged answers while the surrounding conversation rerenders", () => {
  const lex = vi.spyOn(Lexer, "lex");
  const { rerender } = render(<ChatMessageContent text="原回答 **保留**" />);
  expect(lex).toHaveBeenCalledTimes(1);
  rerender(<ChatMessageContent text="原回答 **保留**" />);
  expect(lex).toHaveBeenCalledTimes(1);
  rerender(<ChatMessageContent text="新的回答" />);
  expect(lex).toHaveBeenCalledTimes(2);
  expect(screen.getByText("新的回答")).toBeInTheDocument();
});

it("preserves complete text and the final warning if formatting fails or a reply is unusually large", () => {
  const lex = vi.spyOn(Lexer, "lex").mockImplementation(() => { throw new Error("parse failure"); });
  const text = "原始第一行\n\n**最后的安全提醒**";
  const { container, rerender } = render(<ChatMessageContent text={text} />);
  expect(container.querySelector(".chat-plaintext")?.textContent).toBe(text);
  lex.mockRestore();
  const untouchedLexer = vi.spyOn(Lexer, "lex");
  const longText = "长回复。".repeat(13_000) + "\n末尾安全提醒仍然可见。";
  rerender(<ChatMessageContent text={longText} />);
  expect(untouchedLexer).not.toHaveBeenCalled();
  expect(container.querySelector(".chat-plaintext")?.textContent).toBe(longText);
});
