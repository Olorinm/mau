import {type MouseEvent} from "react";
import {Paperclip} from "lucide-react";
import {useI18n} from "../presentation/i18n";
export type FileTextSelectionAttachment = {
  text: string;
  fileName: string;
  path: string;
  mimeType?: string;
  lineRange?: {
    start: number;
    end: number;
  };
};

export type TextSelectionState = {
  text: string;
  rect: SelectionRect;
};

export type SelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export function SelectionAttachButton(props: { selection: TextSelectionState; onAttach(): void }) {
  const { t } = useI18n();
  const point = selectionButtonPoint(props.selection.rect);
  return (
    <button
      className="file-selection-attach-button"
      type="button"
      style={{
        left: point.left,
        top: point.top,
        transform: point.placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
      data-placement={point.placement}
      title={t("filePreview.addToChat")}
      aria-label={t("filePreview.addSelectionToChat")}
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
      onMouseUp={(event: MouseEvent<HTMLButtonElement>) => event.stopPropagation()}
      onClick={() => {
        props.onAttach();
        document.getSelection()?.removeAllRanges();
      }}
    >
      <Paperclip size={13} />
      <span>{t("filePreview.addToChat")}</span>
    </button>
  );
}

export function readNativeTextSelection(container: HTMLElement | null): TextSelectionState | null {
  if (!container) return null;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && !container.contains(anchor)) || (focus && !container.contains(focus))) return null;
  const rect = selectionRectFromRange(range);
  if (!rect) return null;
  return { text, rect };
}

export function selectionRectFromRange(range: Range): SelectionRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const rect = rects[0] ?? range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
}

export function selectionButtonPoint(rect: SelectionRect): { left: number; top: number; placement: "above" | "below" } {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 56), Math.max(56, viewportWidth - 56));
  if (rect.top > 54) {
    return { left, top: rect.top - 8, placement: "above" };
  }
  return { left, top: rect.bottom + 8, placement: "below" };
}

export function lineRangeForSelection(content: string, selectedText: string): FileTextSelectionAttachment["lineRange"] {
  const trimmedSelection = selectedText.trim();
  if (!content || !trimmedSelection) return undefined;
  const index = content.indexOf(selectedText);
  const fallbackIndex = index >= 0 ? index : content.indexOf(trimmedSelection);
  if (fallbackIndex < 0) return undefined;
  const before = content.slice(0, fallbackIndex);
  const selected = content.slice(
    fallbackIndex,
    fallbackIndex + (index >= 0 ? selectedText.length : trimmedSelection.length),
  );
  const start = before.split(/\r\n|\r|\n/).length;
  const end = start + Math.max(0, selected.split(/\r\n|\r|\n/).length - 1);
  return { start, end };
}
