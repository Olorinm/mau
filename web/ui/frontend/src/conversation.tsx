import type { ComponentProps, ReactNode } from 'react';
import { ChatComposer, ChatMessage, ChatTranscript } from '@olorinm/agent-ui';

/** Presentation only: no account IDs, delivery protocol, kernel or run schema. */
export interface MessageView {
  id: string; role: string; title?: ReactNode; avatar?: ReactNode;
  subtitle?: ReactNode; status?: ReactNode; content: ReactNode; actions?: ReactNode;
}
export function Conversation({ header, messages, composer, empty, notice, trailing }: {
  header?: ReactNode; messages: readonly MessageView[];
  composer: ComponentProps<typeof ChatComposer>; empty?: ReactNode; notice?: ReactNode; trailing?: ReactNode;
}) {
  return <section className="af-conversation room-chat-workspace-shell">{header}
    <div className="room-chat-column"><section className="room-message-stream chat-thread-scroll" aria-live="polite">
      {notice}<ChatTranscript messages={messages} getKey={message => message.id} empty={empty}
        renderMessage={({ content, id: _id, ...message }) => <ChatMessage {...message}>{content}</ChatMessage>} />{trailing}
    </section><ChatComposer {...composer} /></div>
  </section>;
}
