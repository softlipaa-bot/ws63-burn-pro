/**
 * 串口原始字节流 → 行的有界切分器（W03）。
 *
 * 旧实现先经 ReadlineParser 再截断，导致“没有换行的字节流”可以一直累积在解析器里。
 * 这里在**原始字节流层**就设上限：
 * - 单行（或单片）最多 maxLineChars 个字符；到上限立刻作为“分段行”输出并计数，绝不静默丢弃；
 * - 用流式 TextDecoder 解码，多字节字符跨 chunk 不会被拆坏；
 * - 每路状态恒定（不随接收量增长），二进制/无换行流表现为固定大小的分段输出。
 */

const DEFAULT_MAX_LINE_CHARS = 4096;

export class LineSplitter {
  /**
   * @param {{maxLineChars?: number, onLine: (text: string, info: {truncated: boolean, partial: boolean}) => void}} opts
   */
  constructor({ maxLineChars = DEFAULT_MAX_LINE_CHARS, onLine }) {
    this.maxLineChars = Math.max(64, Number(maxLineChars) || DEFAULT_MAX_LINE_CHARS);
    this.onLine = onLine;
    this.decoder = new TextDecoder("utf-8", { fatal: false });
    this.line = "";
    this.truncatedSegments = 0;
    this.emittedLines = 0;
    this.bytesIn = 0;
  }

  /** 当前未输出的残留字符数（用于验证缓冲有界）。 */
  get pendingChars() {
    return this.line.length;
  }

  /** @param {Buffer|Uint8Array} chunk */
  push(chunk) {
    if (!chunk || !chunk.byteLength) return;
    this.bytesIn += chunk.byteLength;
    const text = this.decoder.decode(chunk, { stream: true });
    if (text) this.appendText(text);
  }

  /** 定时/停止时把残留当作一行输出（partial=true）。 */
  flush() {
    if (!this.line) return;
    const text = this.line;
    this.line = "";
    this.emit(text, { truncated: false, partial: true });
  }

  appendText(text) {
    let rest = text;
    while (rest.length) {
      const nl = rest.indexOf("\n");
      if (nl >= 0) {
        const head = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        this.pushSegment(head);
        this.emitLine();
        continue;
      }
      this.pushSegment(rest);
      rest = "";
    }
  }

  pushSegment(segment) {
    if (!segment) return;
    let rest = segment;
    for (;;) {
      const room = this.maxLineChars - this.line.length;
      if (rest.length <= room) {
        this.line += rest;
        return;
      }
      this.line += rest.slice(0, Math.max(0, room));
      rest = rest.slice(Math.max(0, room));
      // 到上限：作为分段行输出（有计数，不是静默丢弃）
      this.truncatedSegments += 1;
      this.emitLine({ truncated: true });
      if (!rest.length) return;
    }
  }

  emitLine(info) {
    if (!this.line) return;
    const text = this.line;
    this.line = "";
    this.emit(text, info);
  }

  emit(text, info) {
    const clean = text.replace(/\r$/, "");
    if (!clean) return;
    this.emittedLines += 1;
    this.onLine(clean, {
      truncated: Boolean(info?.truncated),
      partial: Boolean(info?.partial),
    });
  }
}
