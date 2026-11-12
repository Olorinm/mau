// Extracted from web/src/components/rooms/rooms-view.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useEffect, useRef, type KeyboardEvent } from "react";
export function useRoomComposerKeyboard<T>({
  mentionMenu,
  mentionOptions,
  moveMentionSelection,
  applyMention,
  sendDraft,
}: {
  mentionMenu: { open: boolean; activeIndex: number };
  mentionOptions: readonly T[];
  moveMentionSelection(delta: number): void;
  applyMention(value: T): void;
  sendDraft(): void;
}) {
  const compositionGuardTimerRef = useRef<number | null>(null);
  const compositionEndedByEnterRef = useRef(false);
  const isComposingTextRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  useEffect(
    () => () => {
      if (compositionGuardTimerRef.current !== null)
        window.clearTimeout(compositionGuardTimerRef.current);
    },
    [],
  );
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
    const isImeEvent =
      isComposingTextRef.current ||
      nativeEvent.isComposing ||
      event.key === "Process" ||
      nativeEvent.keyCode === 229;
    if (isImeEvent) {
      compositionEndedByEnterRef.current =
        event.key === "Enter" ||
        nativeEvent.code === "Enter" ||
        nativeEvent.keyCode === 13;
      return;
    }
    if (event.key === "Enter" && suppressNextEnterRef.current) {
      event.preventDefault();
      suppressNextEnterRef.current = false;
      return;
    }

    if (mentionMenu.open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveMentionSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveMentionSelection(-1);
        return;
      }
      const activeMention = mentionOptions[mentionMenu.activeIndex];
      if ((event.key === "Enter" || event.key === "Tab") && activeMention) {
        event.preventDefault();
        applyMention(activeMention);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDraft();
    }
  }
  function handleComposerCompositionStart() {
    if (compositionGuardTimerRef.current !== null) {
      window.clearTimeout(compositionGuardTimerRef.current);
      compositionGuardTimerRef.current = null;
    }
    isComposingTextRef.current = true;
    compositionEndedByEnterRef.current = false;
    suppressNextEnterRef.current = false;
  }
  function handleComposerCompositionEnd() {
    isComposingTextRef.current = false;
    suppressNextEnterRef.current = compositionEndedByEnterRef.current;
    compositionEndedByEnterRef.current = false;
    if (!suppressNextEnterRef.current) return;
    compositionGuardTimerRef.current = window.setTimeout(() => {
      suppressNextEnterRef.current = false;
      compositionGuardTimerRef.current = null;
    }, 120);
  }
  return {
    onKeyDown: handleComposerKeyDown,
    onCompositionStart: handleComposerCompositionStart,
    onCompositionEnd: handleComposerCompositionEnd,
  };
}
