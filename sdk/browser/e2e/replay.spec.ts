/** Replay in real browsers: both formats, masking, page close, recovery by a later page. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ReplayRecord } from "../test/helpers/proto";
import { captured, diagnostics, open, pageErrors, payload, setCollectorFault } from "./harness";

const SECRETS = ["Jane", "born 1970", "4111111111111111", "Masked again inside unmask", "Patient Jane Doe", "Welcome back"];

function checkStream(list: ReplayRecord[]): void {
  list.forEach((c, i) => {
    expect(c.attributes["ouo.replay.sequence"]).toBe(i);
    expect(c.attributes["ouo.replay.sha256"]).toBe(createHash("sha256").update(c.body!).digest("hex"));
    expect(c.attributes["ouo.replay.byte_size"]).toBe(c.body!.byteLength);
    expect(c.attributes["ouo.replay.masked"]).toBe(true);
    expect(c.scope).toBe("ouo.replay");
  });
  expect(list[0]!.attributes["ouo.replay.keyframe"]).toBe(true);
  expect(new Set(list.map((c) => c.attributes["ouo.replay.stream.id"])).size).toBe(1);
}

test("structure: masked rrweb events in ordered, hashed chunks; page close ends the stream", async ({ page }) => {
  await open(page, "/?replay=session");
  await page.click("#mutate");
  await page.fill("#name", "John Smith");
  await page.waitForTimeout(1200);
  await page.goto("about:blank");
  await page.waitForTimeout(800);
  const c = await captured(page);
  checkStream(c.chunks);
  expect(c.chunks[0]!.attributes["ouo.replay.format"]).toBe("rrweb/2");
  const text = payload(c.chunks).toString("utf8");
  const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: number });
  expect(events[0]!.type).toBe(4);
  expect(events[1]!.type).toBe(2);
  for (const s of [...SECRETS, "John Smith", "Added at"]) expect(text, s).not.toContain(s);
  expect(text).toContain("***");
  expect(text).toContain("Public heading");
  expect(text).not.toContain("avatar.svg");
  // The stream of the closed page ended, and its last chunk left uncompressed with the page.
  expect(c.ended).toHaveLength(1);
  expect(c.ended[0]!.attributes).toMatchObject({ "ouo.replay.end_reason": "pagehide", "ouo.replay.last_sequence": c.chunks.length - 1 });
  expect(c.replay.filter((r) => r.eventName === "ouo.replay.chunk").length).toBe(c.chunks.length);
});

test("pixel: masked images of the viewport, taken when the page changes, none while it is still", async ({ page, browserName }, info) => {
  await open(page, "/?replay=session&format=pixel");
  await expect.poll(async () => (await captured(page)).chunks.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  const still = (await captured(page)).chunks.length;
  await page.waitForTimeout(1500);
  // A static page sends no more frames.
  expect((await captured(page)).chunks.length).toBe(still);
  await page.click("#mutate");
  // The click itself is a pointer record; the changed page is a new frame a moment later.
  await expect.poll(async () => (await captured(page)).chunks.length, { timeout: 15_000 }).toBeGreaterThan(still + 1);
  const c = await captured(page);
  checkStream(c.chunks);
  expect(c.chunks[0]!.attributes).toMatchObject({ "ouo.replay.format": "ouo.frames/1", "ouo.replay.encoding": "none" });

  // Decode the records: u32 header length, header JSON, u32 payload length, payload.
  const bytes = payload(c.chunks);
  const frames: Array<{ header: Record<string, unknown>; image: Buffer }> = [];
  for (let off = 0; off + 8 <= bytes.length; ) {
    const hl = bytes.readUInt32BE(off);
    const header = JSON.parse(bytes.subarray(off + 4, off + 4 + hl).toString("utf8")) as Record<string, unknown>;
    const pl = bytes.readUInt32BE(off + 4 + hl);
    frames.push({ header, image: bytes.subarray(off + 8 + hl, off + 8 + hl + pl) });
    off += 8 + hl + pl;
  }
  const images = frames.filter((f) => f.header["k"] === "frame");
  expect(images.length).toBeGreaterThanOrEqual(2);
  for (const f of images) {
    expect(f.header["masked"]).toBe(true);
    expect(["image/webp", "image/jpeg"]).toContain(f.header["mime"]);
    expect(f.image.length).toBeGreaterThan(500);
    // WebP ("RIFF") or JPEG (FF D8) magic bytes: a real image.
    expect(f.image.subarray(0, 4).toString("latin1") === "RIFF" || (f.image[0] === 0xff && f.image[1] === 0xd8)).toBe(true);
    // The image is pixels only: no text of the page is inside the bytes.
    for (const s of SECRETS) expect(f.image.includes(s)).toBe(false);
  }
  expect(frames.some((f) => f.header["k"] === "pointer")).toBe(true);
  const dir = join(info.project.outputDir, "..", "pixel-frames");
  mkdirSync(dir, { recursive: true });
  const last = images[images.length - 1]!;
  writeFileSync(join(dir, `${browserName}.${last.header["mime"] === "image/webp" ? "webp" : "jpg"}`), last.image);
  expect(await pageErrors(page)).toEqual([]);
  expect((await diagnostics(page)).internalErrors).toBe(0);
});

test("buffer mode: nothing leaves until the page throws, then the buffered replay does", async ({ page }) => {
  await open(page, "/?replay=buffer");
  await page.click("#mutate");
  await page.waitForTimeout(1500);
  expect((await captured(page)).replay).toHaveLength(0);
  await page.click("#throw");
  await expect.poll(async () => (await captured(page)).chunks.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const c = await captured(page);
  checkStream(c.chunks);
  expect(c.chunks[0]!.attributes).toMatchObject({ "ouo.replay.mode": "buffer", "ouo.replay.trigger": "error" });
});

test("collector down: chunks wait in IndexedDB and a later page delivers the stream and ends it", async ({ page }) => {
  await open(page, "/?replay=session");
  await setCollectorFault(page, { status: 503 });
  await page.click("#mutate");
  await page.waitForTimeout(1500);
  await page.goto("about:blank");
  await page.waitForTimeout(500);
  expect((await captured(page)).replay).toHaveLength(0);
  await setCollectorFault(page, {});
  // A page that does not record itself still drains what the earlier one left.
  await page.goto("/?replay=off");
  await expect(page.locator("#status")).toHaveText("ready");
  await expect.poll(async () => (await captured(page)).ended.length, { timeout: 30_000, intervals: [1000] }).toBe(1);
  const c = await captured(page);
  const stream = c.ended[0]!.attributes["ouo.replay.stream.id"];
  const mine = c.chunks.filter((k) => k.attributes["ouo.replay.stream.id"] === stream);
  // At-least-once delivery: duplicates by identity are allowed, gaps are not.
  const seqs = [...new Set(mine.map((k) => Number(k.attributes["ouo.replay.sequence"])))].sort((a, b) => a - b);
  expect(seqs).toEqual(seqs.map((_, i) => i));
  expect(c.ended[0]!.attributes["ouo.replay.last_sequence"]).toBe(seqs.length - 1);
  expect(await pageErrors(page)).toEqual([]);
});
