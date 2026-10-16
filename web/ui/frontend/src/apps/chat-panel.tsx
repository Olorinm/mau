import {useId,useRef,useState,type ReactNode} from "react";
import {ChevronDown,MessageCircle,Search,Plus,X} from "lucide-react";
import {Dialog,DialogContent,DialogTitle,Tooltip} from "@olorinm/agent-ui/app";
import {MotionPopover} from "../ui/popover";
import {UnreadCount} from "../presentation/unread-count";
import {useI18n} from "../presentation/i18n";
export interface AppChatGroupView {id:string;title:string;avatar?:ReactNode;unread:number;description:string}
export function AppChatPanel(props:{title:string;active?:{title:string;avatar?:ReactNode};groups:readonly AppChatGroupView[];children?:ReactNode;headerActions?:ReactNode;memberPopover?:ReactNode;emptyTitle?:string;emptyDescription?:string;onSelectGroup(id:string):void;onCreateGroup?():void}){
 const {t}=useI18n();const headerRef=useRef<HTMLElement>(null);const [selectorOpen,setSelectorOpen]=useState(false);const [query,setQuery]=useState("");
 const visibleGroups=props.groups.filter(g=>g.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const select=(id:string)=>{setSelectorOpen(false);props.onSelectGroup(id)};
 return <section className="mounted-app-room-chat" aria-label={t("mountedApp.chatPanelLabel",{title:props.title})}><header className="mounted-app-room-chat-header" ref={headerRef}>
        <div className="mounted-app-room-target-shell">
          <MotionPopover
            open={selectorOpen}
            onOpenChange={setSelectorOpen}
            anchorRef={headerRef}
            side="bottom"
            sideOffset={0}
            align="start"
            collisionPadding={0}
            className="mounted-app-room-picker"
            role="dialog"
            ariaLabel={t("mountedApp.switchChat")}
            trigger={
              <button
                className="mounted-app-room-target"
                type="button"
                aria-expanded={selectorOpen}
              >
                <span className="mounted-app-room-target-icon">
                  {props.active?.avatar ?? <MessageCircle size={18} />}
                </span>
                <span>
                  <strong>
                    {props.active?.title || t("mountedApp.selectChat")}
                  </strong>
                </span>
                <ChevronDown size={15} />
              </button>
            }
          >
            <label className="mounted-app-room-picker-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("mountedApp.searchGroups")}
              />
              {query ? (
                <Tooltip content={t("mountedApp.clearSearch")}>
                  <button type="button" onClick={() => setQuery("")} aria-label={t("mountedApp.clearSearch")}>
                    <X size={13} />
                  </button>
                </Tooltip>
              ) : null}
            </label>
            <div className="mounted-app-room-picker-section">
              <span>{t("mountedApp.groups")}</span>
              {visibleGroups.map((room) => (
                <button
                  type="button"
                  key={room.id}
                  onClick={() => select(room.id)}
                  aria-label={
                    room.unread ? t("rooms.unreadCount", { title: room.title, count: room.unread }) : room.title
                  }
                >
                  {room.avatar}
                  <span>
                    <strong>{room.title}</strong>
                    <small>{room.description}</small>
                  </span>
                  <UnreadCount count={room.unread} className="mounted-app-room-picker-unread" />
                </button>
              ))}
              {!props.groups.length ? <div className="mounted-app-room-picker-empty">{t("mountedApp.emptyNoEmployees")}</div> : !visibleGroups.length ? <div className="mounted-app-room-picker-empty">{t("mountedApp.noMatchingGroups")}</div> : null}
              {props.onCreateGroup ? (
                <button type="button" className="mounted-app-room-create-button" onClick={()=>{setSelectorOpen(false);props.onCreateGroup?.()}}>
                  <span className="mounted-app-room-create-icon" aria-hidden="true">
                    <Plus size={16} />
                  </span>
                  <span>
                    <strong>{t("mountedApp.createGroup")}</strong>
                    <small>{t("mountedApp.createGroupHint")}</small>
                  </span>
                </button>
              ) : null}
            </div>
          </MotionPopover>
        </div>
{props.headerActions}{props.memberPopover}</header>{props.children??<div className="mounted-app-room-empty"><MessageCircle size={20}/><strong>{props.emptyTitle}</strong><p>{props.emptyDescription}</p></div>}</section>;
}
export function AppCreateGroupDialog(props:{open:boolean;onOpenChange(open:boolean):void;title:string;onTitleChange(value:string):void;onCreate():void;disabled?:boolean;pending?:boolean}){const {t}=useI18n();return (      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="mounted-app-create-group-dialog" aria-label={t("mountedApp.createGroup")}>
          <DialogTitle>{t("mountedApp.createGroup")}</DialogTitle>
          <form aria-busy={props.pending}
            className="mounted-app-create-group-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.disabled && !props.pending) props.onCreate();
            }}
          >
            <label className="mounted-app-create-group-field">
              <span>{t("mountedApp.groupName")}</span>
              <input
                autoFocus
                value={props.title}
                onChange={(event) => props.onTitleChange(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={props.disabled || props.pending}>
                {t("mountedApp.create")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
);}
export function AppDeleteGroupDialog(props:{open:boolean;title:string;error?:string;pending?:boolean;onOpenChange(open:boolean):void;onDelete():void}){const {t}=useI18n();const descriptionId=useId();return (      <Dialog
        open={props.open}
        onOpenChange={open=>{if(!props.pending)props.onOpenChange(open)}}
      >
        <DialogContent
          className="mounted-app-create-group-dialog"
          aria-label={t("rooms.dissolveGroup")}
          aria-describedby={descriptionId}
        >
          <DialogTitle>{t("rooms.dissolveGroup")}</DialogTitle>
          <p id={descriptionId}>
            {t("rooms.dissolveGroupConfirm", { title: props.title })}
          </p>
          {props.error ? (
            <p className="mounted-app-delete-group-error">
              {t("rooms.dissolveGroupFailedWithDetail", { message: props.error })}
            </p>
          ) : null}
          <div className="modal-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={()=>props.onOpenChange(false)}
              disabled={props.pending}
            >
              {t("common.cancel")}
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={props.onDelete}
              disabled={props.pending}
            >
              {props.pending ? t("mountedApp.props.pending") : t("rooms.dissolveGroup")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
);}
