// Extracted from web/src/runtime/app-layout-resize.ts at 8b365ed. See source-manifest.json for boundary changes.
export function beginPointerDrag(options: {
  handle: HTMLElement;
  pointerId: number;
  onMove(event: PointerEvent): void;
  onFinish(event?: Event): void;
}) {
  let active = true;
  options.handle.dataset.resizing = "true";

  function finish(event?: Event) {
    if (!active) return;
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    if (event instanceof PointerEvent && event.pointerId !== options.pointerId)
      return;
    active = false;
    delete options.handle.dataset.resizing;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    window.removeEventListener("keydown", finish);
    document.removeEventListener("visibilitychange", finishWhenHidden);
    options.handle.removeEventListener("lostpointercapture", finish);
    try {
      if (options.handle.hasPointerCapture(options.pointerId)) {
        options.handle.releasePointerCapture(options.pointerId);
      }
    } catch {
      // non-critical-fallback: A detached handle needs no pointer-capture release before finishing resize.
    }
    options.onFinish(event);
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== options.pointerId) return;
    if (event.buttons === 0) {
      finish(event);
      return;
    }
    options.onMove(event);
  }

  function finishWhenHidden() {
    if (document.visibilityState === "hidden") finish();
  }

  try {
    options.handle.setPointerCapture(options.pointerId);
  } catch {
    // Window listeners still provide a safe fallback when capture is unavailable.
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  window.addEventListener("keydown", finish);
  document.addEventListener("visibilitychange", finishWhenHidden);
  options.handle.addEventListener("lostpointercapture", finish);

  return () => finish();
}
