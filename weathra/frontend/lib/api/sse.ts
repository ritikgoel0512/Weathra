/**
 * A server-sent-events parser over a byte stream.
 *
 * `EventSource` would do this for free and cannot be used: it has no way to set an `Authorization`
 * header, and Weathra's stream is authenticated by bearer token like every other protected call
 * (design.md decision 18). So the stream is a `fetch` whose body is read with a reader, and the
 * framing is parsed here.
 *
 * **Chunks are not events.** A read returns whatever arrived — half an event, three events, or the
 * middle of a UTF-8 character. So the parser holds a buffer across calls and yields only complete
 * blocks (terminated by a blank line), and decoding is streaming so a multi-byte character split
 * across two reads is not corrupted.
 *
 * Weathra's stream sends a named event and one JSON data line per block
 * (`weathra/api/streaming.py`), which is the subset handled here. Comment lines — a `:` heartbeat —
 * are ignored rather than treated as data.
 */

/** One parsed SSE block. */
export interface SseFrame {
  /** The `event:` name, or null when the block did not name one. */
  readonly event: string | null;
  /** The `data:` lines, joined by newlines as the SSE specification requires. */
  readonly data: string;
}

/** Parses a stream of chunks into frames, holding partial blocks between calls. */
export interface SseParser {
  /** The frames completed by this chunk. */
  push(chunk: string): SseFrame[];
  /** Any frame left in the buffer when the stream ended without a final blank line. */
  flush(): SseFrame[];
}

function parseBlock(block: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | null = null;

  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "" || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    // One optional space after the colon is part of the framing, not of the value.
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (event === null && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export function createSseParser(): SseParser {
  let buffer = "";

  function drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    // A block ends at a blank line, which may use either line ending.
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (blocks.pop() ?? "");

    for (const block of blocks) {
      const frame = parseBlock(block);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): SseFrame[] {
      if (buffer.trim() === "") {
        buffer = "";
        return [];
      }
      return drain(true);
    },
  };
}

/** Read a `fetch` response body as SSE frames. */
export async function* readSseFrames(response: Response): AsyncGenerator<SseFrame> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across two reads intact.
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        yield frame;
      }
    }
    for (const frame of parser.push(decoder.decode())) yield frame;
    for (const frame of parser.flush()) yield frame;
  } finally {
    reader.releaseLock();
  }
}
