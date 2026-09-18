import { createElement, Fragment, memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Lexer, type MarkedToken, type Token } from "marked";
import "./chat-message-content.css";

type ChatMessageContentProps = { text: string; onReading?: () => void };

function shortPlainParagraphs(tokens: Token[]): ReactNode[] | null {
  // Only unformatted paragraphs qualify. Lists, links, code and quotes retain
  // their original structure, and no sentence or ending is summarized away.
  if (!tokens.every(token => token.type === "space" || token.type === "paragraph"
    && token.tokens?.every(child => child.type === "text" && !("tokens" in child && child.tokens)))) return null;
  return tokens.flatMap((token, tokenIndex) => {
    if (token.type !== "paragraph" || !token.tokens) return [];
    const text = token.tokens.map(child => "text" in child ? child.text : "").join("");
    if (text.length < 180) return [<p className="chat-paragraph" key={tokenIndex}>{text}</p>];
    const sentences = text.match(/[^。！？!?]*[。！？!?]+[”’」』）)\]]*|[^。！？!?]+$/gu) ?? [text];
    // Guard against a future tokenizer/regexp change losing any characters.
    if (sentences.join("") !== text) return [<p className="chat-paragraph" key={tokenIndex}>{text}</p>];
    const paragraphs: string[] = [];
    let paragraph = "";
    for (const sentence of sentences) {
      paragraph += sentence;
      if (paragraph.length >= 90) { paragraphs.push(paragraph); paragraph = ""; }
    }
    if (paragraph) paragraphs.push(paragraph);
    return paragraphs.map((part, index) => <p className="chat-paragraph" key={`${tokenIndex}-${index}`}>{part}</p>);
  });
}

function safeLink(href: string): string | null {
  // Accept complete web addresses only; never interpret application routes,
  // encoded schemes or control characters as executable/navigation markup.
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderTokens(tokens: Token[]): ReactNode[] {
  // This lexer has no extensions, so it produces Marked's built-in tokens.
  return tokens.map((token, index) => (
    <Fragment key={index}>{renderToken(token as MarkedToken)}</Fragment>
  ));
}

function renderToken(token: MarkedToken): ReactNode {
  const raw = token.raw;
  switch (token.type) {
    case "space": return null;
    case "paragraph": return <p className="chat-paragraph">{renderTokens(token.tokens)}</p>;
    case "text": return token.tokens ? renderTokens(token.tokens) : token.text;
    case "escape": return token.text;
    case "br": return <br />;
    case "strong": return <strong>{renderTokens(token.tokens)}</strong>;
    case "em": return <em>{renderTokens(token.tokens)}</em>;
    case "del": return <del>{renderTokens(token.tokens)}</del>;
    case "codespan": return <code>{token.text}</code>;
    case "code": return <pre className="chat-codeblock" tabIndex={0} aria-label="代码"><code>{token.text}</code></pre>;
    case "heading":
      // Keep the page's h1/h2 hierarchy above headings inside a reply.
      return createElement(`h${Math.min(6, Math.max(3, token.depth + 1))}`,
        { className: "chat-subheading" }, renderTokens(token.tokens));
    case "hr": return <hr />;
    case "blockquote": return <blockquote>{renderTokens(token.tokens)}</blockquote>;
    case "list": {
      const items = token.items.map((item, index) => <li key={index}>{renderTokens(item.tokens)}</li>);
      return token.ordered ? <ol start={token.start || 1}>{items}</ol> : <ul>{items}</ul>;
    }
    case "list_item": return <li>{renderTokens(token.tokens)}</li>;
    case "checkbox": return <span className="chat-task-status">{token.checked ? "[x] " : "[ ] "}</span>;
    case "link": {
      const href = safeLink(token.href);
      return href
        ? <a href={href} target="_blank" rel="noopener noreferrer">{renderTokens(token.tokens)}</a>
        : <span className="chat-literal">{raw}</span>;
    }
    case "table": return (
      <div className="chat-table-scroll" role="region" aria-label="回答中的表格，可横向滚动" tabIndex={0}>
        <table>
          <thead><tr>{token.header.map((cell, index) => (
            <th key={index} scope="col" style={{ textAlign: cell.align ?? undefined }}>{renderTokens(cell.tokens)}</th>
          ))}</tr></thead>
          <tbody>{token.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((cell, index) => <td key={index} style={{ textAlign: cell.align ?? undefined }}>{renderTokens(cell.tokens)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    );
    // Raw HTML and remote images stay readable text. They never create DOM
    // elements, trigger requests, or hide embedded safety advice.
    case "html": return token.block ? <p className="chat-paragraph chat-literal">{raw}</p> : <span className="chat-literal">{raw}</span>;
    case "image":
    case "def": return <span className="chat-literal">{raw}</span>;
    default: return <span className="chat-literal">{raw}</span>;
  }
}

/** Safe, synchronous answer formatting. Unchanged messages do not reparse while typing. */
const ChatMessageContent = memo(function ChatMessageContent({ text, onReading }: ChatMessageContentProps) {
  const [large, setLarge] = useState(false);
  const beginning = useRef<HTMLDivElement>(null);
  const longAnswer = text.length >= 400;
  const content = useMemo(() => {
    try {
    // Keep unusually large replies readable without expensive Markdown work on
    // a phone. This fallback preserves the entire reply, including its ending.
    if (text.length > 50_000) return <div className="chat-plaintext">{text}</div>;
    const tokens = Lexer.lex(text, { gfm: true, breaks: true });
    return shortPlainParagraphs(tokens) ?? renderTokens(tokens);
    } catch {
      return <div className="chat-plaintext">{text}</div>;
    }
  }, [text]);
  return <div className={`chat-answer-reader${large ? " is-large" : ""}`}>
    {longAnswer ? <div className="chat-reading-tools"><span>全文阅读</span><button type="button" aria-pressed={large}
      onClick={() => { onReading?.(); setLarge(value => !value); }}>{large ? "恢复字号" : "放大字号"}</button></div> : null}
    <div ref={beginning} tabIndex={longAnswer ? -1 : undefined} className="chat-message-content">{content}</div>
    {longAnswer ? <button type="button" className="chat-read-from-start" onClick={() => {
      onReading?.();
      beginning.current?.focus({ preventScroll: true });
      beginning.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
    }}>回到这条回答开头 ↑</button> : null}
  </div>;
});

export default ChatMessageContent;
