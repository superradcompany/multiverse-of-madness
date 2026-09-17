import test from "node:test";
import assert from "node:assert/strict";
import { readProgressEvents } from "./progression.ts";
const event = (tag: number, n: number) => {
  const b = new ArrayBuffer(8),
    v = new DataView(b);
  v.setUint16(0, tag, true);
  v.setUint16(2, 4, true);
  v.setInt32(4, n, true);
  return v;
};
test("locked and collected key events use pinned card and skull ABI", () => {
  assert.deepEqual(readProgressEvents(event(160, 2), 9), [
    { kind: "locked", key: "red", tick: 9 },
  ]);
  assert.deepEqual(readProgressEvents(event(141, 3), 10), [
    { kind: "key", key: "blue", tick: 10 },
  ]);
  assert.deepEqual(readProgressEvents(event(141, 8), 10), []);
  const truncated = event(160, 2);
  truncated.setUint16(2, 8, true);
  assert.throws(() => readProgressEvents(truncated, 9), /Truncated/);
});
