import { marked, type Token, type Tokens } from "marked";

export interface Entity { type:string; offset:number; length:number; url?:string; language?:string }
export interface TelegramText { text:string; entities:Entity[] }

/** Telegram entities use UTF-16 offsets, just like JavaScript strings. No HTML passthrough. */
export function telegramText(markdown: string): TelegramText[] {
  let text = ""; const entities: Entity[] = []; let quoteDepth = 0;
  const decode = (s:string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, v => ({ "&amp;":"&", "&lt;":"<", "&gt;":">", "&quot;":'"', "&#39;":"'" })[v]!);
  const span = (type:string, render:() => void, extra:Partial<Entity> = {}) => { const offset=text.length; render(); if(text.length>offset) entities.push({type,offset,length:text.length-offset,...extra}); };
  const walk = (tokens: Token[], listDepth = 0) => { for (const token of tokens) {
    const t = token as Token & { tokens?:Token[]; items?:Array<{ tokens:Token[] }>; text?:string; href?:string; lang?:string; ordered?:boolean; start?:number };
    const inner = () => t.tokens ? walk(t.tokens, listDepth) : text += decode(t.text ?? t.raw);
    switch (t.type) {
      // Block renderers already supply spacing; lexer space tokens are separators,
      // not extra content. Do not collapse the final string: code may contain blanks.
      case "space": break;
      case "strong": span("bold",inner); break;
      case "em": span("italic",inner); break;
      case "del": span("strikethrough",inner); break;
      case "codespan": span("code",() => { text += t.text ?? ""; }); break;
      case "code": span("pre",() => { text += t.text ?? ""; }, t.lang ? {language:t.lang.split(/\s/)[0]} : {}); text += "\n\n"; break;
      case "link": if (/^https?:\/\//i.test(t.href ?? "")) span("text_link",inner,{url:t.href}); else inner(); break;
      case "image": text += t.text ?? ""; if (/^https?:\/\//i.test(t.href ?? "")) text += ` (${t.href})`; break;
      case "br": text += "\n"; break;
      case "heading": span("bold",inner); text += "\n\n"; break;
      case "paragraph": inner(); text += "\n\n"; break;
      case "blockquote": {
        const offset=text.length, firstEntity=entities.length;
        quoteDepth++; inner(); quoteDepth--;
        // Telegram forbids nested quotes and quotes containing links or code.
        const compatible=entities.slice(firstEntity).every(e=>["bold","italic","strikethrough"].includes(e.type));
        const length=text.trimEnd().length-offset;
        if (!quoteDepth && compatible && length>0) entities.push({type:"blockquote",offset,length});
        break;
      }
      case "list":
        if (listDepth && !text.endsWith("\n")) text += "\n";
        t.items?.forEach((item,i) => {
          text += "  ".repeat(listDepth) + (t.ordered ? `${Number(t.start ?? 1)+i}. ` : "• ");
          walk(item.tokens,listDepth+1);
          if (!text.endsWith("\n")) text += "\n";
        });
        if (!listDepth) text += "\n";
        break;
      case "table": {
        const table=t as Tokens.Table;
        for (const row of table.rows) {
          row.forEach((cell,i) => {
            const header=table.header[i];
            if (header) { span("bold",()=>walk(header.tokens)); text += ": "; }
            walk(cell.tokens); text += "\n";
          });
          text += "\n";
        }
        break;
      }
      case "hr": text += "———\n"; break;
      default: inner();
    }
  } };
  walk(marked.lexer(markdown));
  text = text.trimEnd();
  // Code cannot overlap other entities, even if Markdown permits that nesting.
  const code=entities.filter(e=>e.type==="code" || e.type==="pre");
  const compatibleEntities=entities.filter(e=>code.includes(e) || !code.some(c=>c.offset<e.offset+e.length && c.offset+c.length>e.offset));
  const chunks:TelegramText[]=[];
  for(let start=0;start<text.length;) {
    let end=Math.min(start+4096,text.length);
    if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!)) end--;
    chunks.push({text:text.slice(start,end),entities:compatibleEntities.flatMap(e => {
      const lo=Math.max(e.offset,start), hi=Math.min(e.offset+e.length,end);
      return hi>lo ? [{...e,offset:lo-start,length:hi-lo}] : [];
    })}); start=end;
  }
  return chunks;
}
