import {afterEach, expect, it, vi} from "vitest";
import {blockBuildReload, startBuildVersionWatcher} from "../web/src/build-version.js";
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});
it("updates an idle stale page once, preserves unsent work and disposes its watcher", async () => {
 vi.useFakeTimers(); const reload = vi.fn(), stored = new Map<string,string>();
 const document = new EventTarget() as EventTarget & {hidden: boolean}; document.hidden = false;
 vi.stubGlobal("document",document);
 vi.stubGlobal("window",{setInterval,clearInterval,sessionStorage:{getItem:(key:string)=>stored.get(key),setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)},location:{reload}});
 const fetcher = vi.fn(async()=>Response.json({buildId:"new"})); vi.stubGlobal("fetch",fetcher);
 const unblock = blockBuildReload(true), stop = startBuildVersionWatcher("old");
 await vi.advanceTimersByTimeAsync(20000); expect(reload).not.toHaveBeenCalled();
 unblock(); await vi.advanceTimersByTimeAsync(20000); expect(reload).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(40000); expect(reload).toHaveBeenCalledTimes(1); stop();
 const retry = startBuildVersionWatcher("old"); await vi.advanceTimersByTimeAsync(20000); expect(reload).toHaveBeenCalledTimes(1); retry();
 const updated = startBuildVersionWatcher("new"); await vi.advanceTimersByTimeAsync(20000); expect(stored.size).toBe(0); updated();
 const count = fetcher.mock.calls.length; await vi.advanceTimersByTimeAsync(40000); expect(fetcher.mock.calls).toHaveLength(count);
});
