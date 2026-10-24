/**
 * Strict Content-Security-Policy and Trusted Types (checklist N42): the SDK and the rrweb chunk
 * it loads run under `script-src 'self'` (no `unsafe-eval`, no `unsafe-inline`), `style-src
 * 'self'` and `require-trusted-types-for 'script'; trusted-types 'none'` with no violation, and
 * still deliver events, a trace and replay.
 */
import { expect, test } from "@playwright/test";
import { captured, flush, open } from "./harness";

test("no CSP or Trusted Types violation, and everything is delivered", async ({ page, browserName }) => {
  await open(page, "/csp.html");
  const policy = await page.evaluate(async () => {
    const res = await fetch(location.href, { method: "HEAD" });
    return res.headers.get("content-security-policy") ?? "";
  });
  expect(policy).toContain("require-trusted-types-for 'script'");
  expect(policy).not.toContain("unsafe-eval");

  // The policy is enforced here: a page inline script would be blocked, and where the engine
  // has Trusted Types, a string reaching a script sink throws.
  const enforced = await page.evaluate(() => {
    const tt = "trustedTypes" in window;
    let sinkThrew = false;
    try {
      document.createElement("script").text = "1";
    } catch {
      sinkThrew = true;
    }
    return { tt, sinkThrew };
  });
  if (enforced.tt) expect(enforced.sinkThrew).toBe(true);
  test.info().annotations.push({ type: "trusted-types", description: `${browserName}: ${JSON.stringify(enforced)}` });
  // That probe was a violation of its own (reported asynchronously): start counting after it.
  await page.waitForTimeout(200);
  await page.evaluate(() => ((window as unknown as { violations: string[] }).violations.length = 0));

  await expect.poll(() => page.evaluate(() => (window as unknown as { rum: { replay: { isRecording(): boolean } } }).rum.replay.isRecording())).toBe(true);
  await page.locator("#mutate").click();
  await page.locator("#name").fill("typed");
  await page.locator("#fetch").click();
  await expect(page.locator("#out")).toHaveAttribute("data-fetched", "200");
  await page.waitForTimeout(800);
  await flush(page);

  const { logs, spans, replay } = await captured(page);
  expect(logs.some((l) => l.eventName === "session.start")).toBe(true);
  expect(spans.some((s) => String(s.attributes["url.full"]).endsWith("/api/csp"))).toBe(true);
  expect(replay.length).toBeGreaterThan(0);
  expect(replay.flatMap((c) => c.events).some((e) => e.type === 2)).toBe(true); // a full snapshot

  expect(await page.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
});
