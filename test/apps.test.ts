import { afterEach, expect, it } from "vitest";
import { listApps } from "../src/apps.js";
import { mauFixture } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("a service without an app directory says so, and the owner's apps are an empty list", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api("/apps")).data).toEqual({ configured: false, data: [] });
});

it("lists an owner's apps from the directory, keeping only what the console may open and draw", async () => {
  const seen: string[] = [];
  const result = await listApps({ list: (owner) => { seen.push(owner); return [
    { id: "report", name: "周报", url: "https://apps.example/report", icon: "/app-icons/report.svg" },
    { id: "ledger", name: "记账", url: "/apps/ledger" },
    // An icon from another origin is dropped: the console's policy loads images from its own origin only.
    { id: "trip", name: "行程", url: "https://apps.example/trip", icon: "https://cdn.example/trip.png" },
    // Not an address the console may open.
    { id: "plain", name: "明文", url: "http://apps.example/plain" },
    { id: "script", name: "脚本", url: "javascript:alert(1)" },
    { id: "elsewhere", name: "别处", url: "//evil.example/x" },
    { id: "", name: "无名", url: "https://apps.example/none" },
  ]; } }, "@alice:example.test");
  expect(seen).toEqual(["@alice:example.test"]);
  expect(result).toEqual({ configured: true, data: [
    { id: "report", name: "周报", url: "https://apps.example/report", icon: "/app-icons/report.svg" },
    { id: "ledger", name: "记账", url: "/apps/ledger" },
    { id: "trip", name: "行程", url: "https://apps.example/trip" },
  ] });
});
