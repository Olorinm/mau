import { FileCode2, FileText, File, Image } from "lucide-react";

/** A file in a sent message: type icon, name and a kind line ("Text", "PDF · 45 KB"). Opening it belongs to the caller. */
export function MessageFileCard(props: {
  name: string;
  kind?: "image" | "text" | "code" | "file";
  detail?: string;
  title?: string;
  onOpen?(): void;
}) {
  const Icon = props.kind === "image" ? Image : props.kind === "code" ? FileCode2 : props.kind === "text" ? FileText : File;
  return (
    <button
      className="room-message-file"
      type="button"
      title={props.title ?? props.name}
      onClick={props.onOpen}
    >
      <span className="room-message-file-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="room-message-file-name">{props.name}</span>
      {props.detail ? <span className="room-message-file-meta">{props.detail}</span> : null}
    </button>
  );
}
