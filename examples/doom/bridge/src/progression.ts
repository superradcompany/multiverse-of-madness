import type { ProgressEvent } from "../../contracts/src/game.ts";
export const keyColors = ["blue", "yellow", "red"] as const;
export function readProgressEvents(
  buffer: DataView,
  tick: number,
): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  for (let at = 0; at + 4 <= buffer.byteLength;) {
    const tag = buffer.getUint16(at, true),
      length = buffer.getUint16(at + 2, true),
      start = at + 4;
    if (start + length > buffer.byteLength)
      throw new Error("Truncated engine event");
    const n = (offset = 0) => buffer.getInt32(start + offset, true);
    if (
      tag === 160 &&
      length === 4 &&
      n() >= 0 &&
      n() < 6 &&
      keyColors[n() % 3]
    )
      events.push({ kind: "locked", key: keyColors[n() % 3]!, tick });
    if (
      tag === 141 &&
      length === 4 &&
      n() >= 0 &&
      n() < 6 &&
      keyColors[n() % 3]
    )
      events.push({ kind: "key", key: keyColors[n() % 3]!, tick });
    if (tag === 161 && length === 12)
      events.push({ kind: "door", sector: n(), direction: n(8), tick });
    if (tag === 162 && length === 4)
      events.push({ kind: "switch", line: n(), tick });
    if (tag === 164 && length === 8)
      events.push({ kind: "lift", sector: n(), tick });
    if (tag === 170 && length <= 512)
      events.push({
        kind: "message",
        text: new TextDecoder().decode(
          new Uint8Array(buffer.buffer, buffer.byteOffset + start, length),
        ),
        tick,
      });
    at = start + length;
  }
  return events;
}
