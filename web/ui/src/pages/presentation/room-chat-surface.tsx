// Extracted from web/src/components/rooms/room-chat-surface.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ComponentProps, ReactNode, Ref } from "react";
import { RoomComposer } from "./room-composer";
export function RoomChatSurface({
  streamRef,
  children,
  composer,
  overlay,
}: {
  streamRef?: Ref<HTMLElement>;
  children: ReactNode;
  composer: ComponentProps<typeof RoomComposer>;
  overlay?: ReactNode;
}) {
  return (
    <section className="room-chat-workspace-shell">
      <div className="room-chat-column">
        <section
          ref={streamRef}
          className="room-message-stream chat-thread-scroll"
          aria-live="polite"
        >
          {children}
        </section>

        <RoomComposer {...composer} />
        {overlay}
      </div>
    </section>
  );
}
