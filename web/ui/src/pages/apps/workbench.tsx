import {useState,useRef,useEffect,useLayoutEffect,type CSSProperties,type ReactNode,type KeyboardEvent,type PointerEvent as ReactPointerEvent} from "react";
import {ResizeHandle} from "../presentation/resize-handle";
import {AnimatedBackground} from "../ui/animated-background";
import {ChevronDown,ChevronRight,FileInput,FilePlus2,FolderPlus,ListChevronsDownUp,ListChevronsUpDown,ListVideo,Loader2,RefreshCw} from "lucide-react";
import {useI18n} from "../presentation/i18n";
import {DirectoryPanel} from "../files/directory-panel";
import {WorkspaceWorkbenchLayout} from "../layouts/workspace-workbench-layout";
import type {WorkspacePane} from "../layouts/adaptive-split-layout";
import controlStyles from "./workbench-controls.module.css";
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));
type MountedAppResizeTarget = "files" | "chat";
type MountedAppWorkbenchLayoutMode = "standard" | "embedded";
type MountedAppWorkbenchLayoutState = {
  filesWidth: number;
  chatWidth: number;
};
type MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: number;
  filesMaxWidth: number;
  // Hard CSS grid floor. This may force overflow when the container cannot satisfy it.
  previewMinWidth: number;
  // Soft JS resize reserve. It caps adjacent panes without preventing the preview from shrinking.
  previewWidthReserve: number;
  chatMinWidth: number;
  chatMaxWidth: number;
  resizeHandleWidth: number;
};

const DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT: MountedAppWorkbenchLayoutState = {
  filesWidth: 280,
  chatWidth: 420,
};
const STANDARD_MOUNTED_APP_WORKBENCH_CONSTRAINTS: MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: 180,
  filesMaxWidth: 520,
  previewMinWidth: 0,
  previewWidthReserve: 320,
  chatMinWidth: 280,
  chatMaxWidth: 860,
  resizeHandleWidth: 10,
};
const COMPACT_EMBEDDED_APP_WORKBENCH_CONSTRAINTS: MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: 130,
  filesMaxWidth: 170,
  previewMinWidth: 190,
  previewWidthReserve: 190,
  chatMinWidth: 210,
  chatMaxWidth: 860,
  resizeHandleWidth: 8,
};
const WIDE_EMBEDDED_APP_WORKBENCH_CONSTRAINTS: MountedAppWorkbenchLayoutConstraints = {
  filesMinWidth: 180,
  filesMaxWidth: 220,
  previewMinWidth: 280,
  previewWidthReserve: 280,
  chatMinWidth: 280,
  chatMaxWidth: 860,
  resizeHandleWidth: 10,
};
// Preserves the retired CSS split: compact through 760px, wide from 761px.
const COMPACT_EMBEDDED_APP_WORKBENCH_MAX_WIDTH = 760;
export interface AppWorkbenchProps {
 id:string;title:string; layoutMode?:MountedAppWorkbenchLayoutMode; pane?:WorkspacePane;onCompactChange?(compact:boolean):void;
 detailOpen?:boolean;onOpenDirectory?():void;chatOpen?:boolean;chat?:ReactNode;preview:ReactNode;directoryContent:ReactNode;
 tabs:readonly {id:string;label:string;count?:number}[];activeTabIndex:number;onSelectTab(index:number):void;
 mode:"view"|"file-tree"|"flow-list"|"dashboard"; workspaceTitle:string;workspacePath?:string;entryCount?:number;
 directoryCollapsed?:boolean;onDirectoryCollapsedChange?(value:boolean):void;treeCollapsed?:boolean;onTreeCollapsedChange?(value:boolean):void;
 refreshing?:boolean;onRefresh?():void;importing?:boolean;importLabel?:string;onImport?():void;onCreateFile?():void;onCreateFolder?():void;
 folderCount?:number;allFoldersOpen?:boolean;onFoldersOpenChange?(value:boolean):void;
 layout?:MountedAppWorkbenchLayoutState;defaultLayout?:MountedAppWorkbenchLayoutState;onLayoutChange?(value:MountedAppWorkbenchLayoutState):void;
 editorBanner?:ReactNode;
}
export function AppWorkbench(props:AppWorkbenchProps){
 const {t}=useI18n();const appId=props.id; const workbenchRef=useRef<HTMLDivElement>(null);
 const [localLayout,setLocalLayout]=useState(props.defaultLayout??DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT);
 const [localCollapsed,setLocalCollapsed]=useState(false);
 const preferredWorkbenchLayout=props.layout??localLayout;
 const directoryCollapsed=props.directoryCollapsed??localCollapsed;
 const setDirectoryCollapsed=(v:boolean)=>{setLocalCollapsed(v);props.onDirectoryCollapsedChange?.(v)};
 const directoryMode=props.mode;const effectiveDirectoryCollapsed=directoryMode==="view"||directoryCollapsed;
 const workbenchChatOpen=!!props.chat&&props.chatOpen!==false;
 const [workbenchContainerWidth,setWorkbenchContainerWidth]=useState(0);
 const resizeCleanupRef=useRef<(()=>void)|null>(null);
  const resizeRef = useRef<{
    target: MountedAppResizeTarget;
    pointerId: number;
    handle: HTMLDivElement;
    directoryCollapsed: boolean;
    startPreferredLayout: MountedAppWorkbenchLayoutState;
    startX: number;
    startFilesWidth: number;
    startChatWidth: number;
    containerWidth: number;
    constraints: MountedAppWorkbenchLayoutConstraints;
  } | null>(null);
 const workbenchLayoutConstraints=resolveMountedAppWorkbenchLayoutConstraints(props.layoutMode??"standard",workbenchContainerWidth);
 const effectiveWorkbenchLayout=constrainMountedAppWorkbenchLayout(preferredWorkbenchLayout,workbenchContainerWidth,effectiveDirectoryCollapsed,workbenchChatOpen,workbenchLayoutConstraints);
 useEffect(()=>()=>resizeCleanupRef.current?.(),[]);
 useEffect(()=>{setLocalLayout(props.defaultLayout??DEFAULT_MOUNTED_APP_WORKBENCH_LAYOUT);setLocalCollapsed(false)},[appId]);
 function persistWorkbenchLayout(value:MountedAppWorkbenchLayoutState){setLocalLayout(value);props.onLayoutChange?.(value)}
  useLayoutEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench) {
      setWorkbenchContainerWidth(0);
      return;
    }
    let resizeAnimationFrame = 0;
    const measureContainerWidth = () => {
      const width = mountedAppWorkbenchWidth(workbench);
      setWorkbenchContainerWidth((current) => (current === width ? current : width));
    };
    const scheduleContainerWidthMeasurement = () => {
      // ResizeObserver can notify repeatedly before paint; constrain React
      // layout updates to at most one measurement per animation frame.
      if (resizeAnimationFrame) return;
      resizeAnimationFrame = window.requestAnimationFrame(() => {
        resizeAnimationFrame = 0;
        measureContainerWidth();
      });
    };
    measureContainerWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleContainerWidthMeasurement);
      return () => {
        window.removeEventListener("resize", scheduleContainerWidthMeasurement);
        if (resizeAnimationFrame) window.cancelAnimationFrame(resizeAnimationFrame);
      };
    }
    const observer = new ResizeObserver(scheduleContainerWidthMeasurement);
    observer.observe(workbench);
    return () => {
      observer.disconnect();
      if (resizeAnimationFrame) window.cancelAnimationFrame(resizeAnimationFrame);
    };
  }, [appId]);

  function beginWorkbenchResize(target: MountedAppResizeTarget, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const containerWidth = mountedAppWorkbenchWidth(workbenchRef.current);
    const constraints = resolveMountedAppWorkbenchLayoutConstraints(props.layoutMode ?? "standard", containerWidth);
    const startLayout = constrainMountedAppWorkbenchLayout(
      preferredWorkbenchLayout,
      containerWidth,
      effectiveDirectoryCollapsed,
      workbenchChatOpen,
      constraints,
    );
    resizeRef.current = {
      target,
      pointerId: event.pointerId,
      handle,
      directoryCollapsed: effectiveDirectoryCollapsed,
      startPreferredLayout: preferredWorkbenchLayout,
      startX: event.clientX,
      startFilesWidth: startLayout.filesWidth,
      startChatWidth: startLayout.chatWidth,
      containerWidth,
      constraints,
    };
    handle.dataset.resizing = "true";

    function finishWorkbenchResize(finishEvent?: Event) {
      const resize = resizeRef.current;
      if (!resize) return;
      if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== resize.pointerId) return;
      resizeRef.current = null;
      delete resize.handle.dataset.resizing;
      window.removeEventListener("pointermove", updateWorkbenchResize);
      window.removeEventListener("pointerup", finishWorkbenchResize);
      window.removeEventListener("pointercancel", finishWorkbenchResize);
      window.removeEventListener("blur", finishWorkbenchResize);
      document.removeEventListener("visibilitychange", finishWorkbenchResizeWhenHidden);
      resize.handle.removeEventListener("lostpointercapture", finishWorkbenchResize);
      resizeCleanupRef.current = null;
      if (resize.handle.hasPointerCapture(resize.pointerId)) {
        resize.handle.releasePointerCapture(resize.pointerId);
      }
    }

    function finishWorkbenchResizeWhenHidden() {
      if (document.visibilityState === "hidden") finishWorkbenchResize();
    }

    function updateWorkbenchResize(moveEvent: PointerEvent) {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== moveEvent.pointerId) return;
      if (moveEvent.buttons === 0) {
        finishWorkbenchResize();
        return;
      }
      const deltaX = moveEvent.clientX - resize.startX;
      const nextLayout =
        resize.target === "files"
          ? {
              ...resize.startPreferredLayout,
              filesWidth: clamp(
                resize.startFilesWidth + deltaX,
                resize.constraints.filesMinWidth,
                maxMountedAppFilesWidthWhenChatYields(resize.containerWidth, workbenchChatOpen, resize.constraints),
              ),
            }
          : {
              ...resize.startPreferredLayout,
              chatWidth: clamp(
                resize.startChatWidth - deltaX,
                resize.constraints.chatMinWidth,
                maxMountedAppChatWidth(
                  resize.containerWidth,
                  resize.startFilesWidth,
                  resize.directoryCollapsed,
                  resize.constraints,
                ),
              ),
            };
      persistWorkbenchLayout(nextLayout);
    }

    resizeCleanupRef.current = () => finishWorkbenchResize();
    window.addEventListener("pointermove", updateWorkbenchResize);
    window.addEventListener("pointerup", finishWorkbenchResize);
    window.addEventListener("pointercancel", finishWorkbenchResize);
    window.addEventListener("blur", finishWorkbenchResize);
    document.addEventListener("visibilitychange", finishWorkbenchResizeWhenHidden);
    handle.addEventListener("lostpointercapture", finishWorkbenchResize);
  }

  function adjustWorkbenchLayoutWithKeyboard(target: MountedAppResizeTarget, event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const containerWidth = mountedAppWorkbenchWidth(workbenchRef.current);
    const constraints = resolveMountedAppWorkbenchLayoutConstraints(props.layoutMode ?? "standard", containerWidth);
    const effectiveLayout = constrainMountedAppWorkbenchLayout(
      preferredWorkbenchLayout,
      containerWidth,
      effectiveDirectoryCollapsed,
      workbenchChatOpen,
      constraints,
    );
    const nextLayout =
      target === "files"
        ? {
            ...preferredWorkbenchLayout,
            filesWidth: clamp(
              effectiveLayout.filesWidth + direction * step,
              constraints.filesMinWidth,
              maxMountedAppFilesWidthWhenChatYields(containerWidth, workbenchChatOpen, constraints),
            ),
          }
        : {
            ...preferredWorkbenchLayout,
            chatWidth: clamp(
              effectiveLayout.chatWidth - direction * step,
              constraints.chatMinWidth,
              maxMountedAppChatWidth(
                containerWidth,
                effectiveLayout.filesWidth,
                effectiveDirectoryCollapsed,
                constraints,
              ),
            ),
          };
    persistWorkbenchLayout(nextLayout);
  }


 return (
      <WorkspaceWorkbenchLayout
        className="mounted-app-workbench"
        pane={props.pane}
        onCompactChange={props.onCompactChange}
        detailOpen={props.detailOpen}
        onOpenDirectory={props.onOpenDirectory}
        directoryCollapsed={directoryMode === "view" || directoryCollapsed}
        chatOpen={props.chatOpen}
        ref={workbenchRef}
        style={
          {
            "--mounted-app-files-width": `${effectiveWorkbenchLayout.filesWidth}px`,
            "--mounted-app-chat-width": `${effectiveWorkbenchLayout.chatWidth}px`,
            "--mounted-app-files-min-width": `${workbenchLayoutConstraints.filesMinWidth}px`,
            "--mounted-app-files-max-width": `${workbenchLayoutConstraints.filesMaxWidth}px`,
            "--mounted-app-preview-min-width": `${workbenchLayoutConstraints.previewMinWidth}px`,
            "--mounted-app-chat-min-width": `${workbenchLayoutConstraints.chatMinWidth}px`,
            "--mounted-app-chat-max-width": `${workbenchLayoutConstraints.chatMaxWidth}px`,
            "--mounted-app-resize-handle-width": `${workbenchLayoutConstraints.resizeHandleWidth}px`,
          } as CSSProperties
        }
        editorBanner={props.editorBanner}
        editorTopbar={
          <div className="mounted-app-pane-topbar">
            <div className="mounted-app-directory-tabs" role="tablist" aria-label={t("mountedApp.viewsLabel")}>
              <AnimatedBackground value={String(props.activeTabIndex)} backgroundClassName="mounted-app-directory-tabs-thumb">
                {props.tabs.map((tab, index) => {
                  const active = index === props.activeTabIndex;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-active={active ? "true" : "false"}
                      data-id={String(index)}
                      key={tab.id}
                      onClick={() => {
                        void props.onSelectTab(index);
                      }}
                    >
                      <span className={controlStyles.tabLabel} title={tab.label}>
                        {tab.label}
                      </span>
                      {Boolean(tab.count) ? (
                        <span className="mounted-app-directory-tabs-count">{tab.count}</span>
                      ) : null}
                    </button>
                  );
                })}
              </AnimatedBackground>
            </div>
          </div>
        }
        directory={
          directoryMode === "view" ? null : (
            <aside
              className="mounted-app-tree-pane"
              aria-label={t("mountedApp.directoryLabel", { title: props.title })}
            >
              <DirectoryPanel
                title={
                  <div className="mounted-app-directory-title-row">
                    <button
                      className="mounted-app-tree-rail-toggle"
                      type="button"
                      onClick={() => setDirectoryCollapsed(true)}
                      aria-label={t("mountedApp.collapseDirectory")}
                      title={t("mountedApp.collapseDirectory")}
                    >
                      <ListVideo size={17} className="mounted-app-rail-icon-flip" />
                    </button>
                    {directoryMode === "file-tree" ? (
                      <button
                        type="button"
                        className="mounted-app-workspace-toggle"
                        aria-expanded={!props.treeCollapsed}
                        onClick={() => props.onTreeCollapsedChange?.(!props.treeCollapsed)}
                        title={props.workspacePath ?? props.workspaceTitle}
                      >
                        <span>{props.workspaceTitle}</span>
                        {props.treeCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      </button>
                    ) : (
                      <span className="mounted-app-directory-root-label" title={(props.tabs[props.activeTabIndex]?.label ?? "")}>
                        <span>{(props.tabs[props.activeTabIndex]?.label ?? "")}</span>
                        {props.entryCount !== undefined ? (
                          <small className="mounted-app-directory-root-count">{props.entryCount}</small>
                        ) : null}
                      </span>
                    )}
                  </div>
                }
                className="mounted-app-directory-panel"
                bodyClassName="mounted-app-tree-scroll"
                actions={
                  directoryMode === "dashboard" ? (
                    <button
                      className="sidebar-mini-action"
                      type="button"
                      disabled={props.refreshing || !props.onRefresh}
                      onClick={props.onRefresh}
                      aria-label={t("mountedApp.refresh")}
                      title={t("mountedApp.refresh")}
                    >
                      <RefreshCw
                        className="mounted-app-dashboard-refresh-icon"
                        data-spinning={props.refreshing || !props.onRefresh ? "true" : "false"}
                        size={15}
                      />
                    </button>
                  ) : directoryMode === "file-tree" ? (
                    <>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        disabled={props.importing || !props.onImport}
                        onClick={props.onImport}
                        aria-label={(props.importLabel ?? t("mountedApp.importFile"))}
                        title={(props.importLabel ?? t("mountedApp.importFile"))}
                      >
                        {props.importing ? <Loader2 size={16} /> : <FileInput size={16} />}
                      </button>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        onClick={() =>
                          props.onCreateFile?.()
                        }
                        disabled={!props.onCreateFile}
                        aria-label={t("mountedApp.newMarkdown")}
                        title={t("mountedApp.newMarkdown")}
                      >
                        <FilePlus2 size={16} />
                      </button>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        onClick={() =>
                          props.onCreateFolder?.()
                        }
                        disabled={!props.onCreateFolder}
                        aria-label={t("mountedApp.newFolder")}
                        title={t("mountedApp.newFolder")}
                      >
                        <FolderPlus size={16} />
                      </button>
                      <button
                        className="sidebar-mini-action"
                        type="button"
                        disabled={!props.folderCount || !props.onFoldersOpenChange}
                        onClick={() => props.onFoldersOpenChange?.(!props.allFoldersOpen)}
                        aria-label={props.allFoldersOpen ? t("mountedApp.collapseAll") : t("mountedApp.expandAll")}
                        title={props.allFoldersOpen ? t("mountedApp.collapseAll") : t("mountedApp.expandAll")}
                      >
                        {props.allFoldersOpen ? <ListChevronsDownUp size={16} /> : <ListChevronsUpDown size={16} />}
                      </button>
                    </>
                  ) : null
                }
              >
                {props.directoryContent}
              </DirectoryPanel>
            </aside>
          )
        }
        directoryResizeHandle={
          directoryMode === "view" ? undefined : (
            <ResizeHandle
              className="mounted-app-resize-handle mounted-app-resize-handle-files"
              aria-label={t("mountedApp.resizeFiles")}
              aria-orientation="vertical"
              aria-valuemin={workbenchLayoutConstraints.filesMinWidth}
              aria-valuemax={maxMountedAppFilesWidthWhenChatYields(
                workbenchContainerWidth,
                workbenchChatOpen,
                workbenchLayoutConstraints,
              )}
              aria-valuenow={effectiveWorkbenchLayout.filesWidth}
              tabIndex={0}
              onPointerDown={(event) => beginWorkbenchResize("files", event)}
              onKeyDown={(event) => adjustWorkbenchLayoutWithKeyboard("files", event)}
            />
          )
        }
        preview={
          <section className="mounted-app-preview-pane" aria-label={t("mountedApp.filePreview")}>
            {directoryMode !== "view" && directoryCollapsed ? (
              <button
                className="mounted-app-directory-reopen"
                type="button"
                onClick={() => setDirectoryCollapsed(false)}
                aria-label={t("mountedApp.expandDirectory")}
                title={t("mountedApp.expandDirectory")}
              >
                <ListVideo size={17} />
              </button>
            ) : null}
            <div className="mounted-app-preview-body">
              {props.preview}
            </div>
          </section>
        }
        chatResizeHandle={
          props.chat ? (
            <ResizeHandle
              className="mounted-app-resize-handle mounted-app-resize-handle-chat"
              aria-label={t("mountedApp.resizeChat")}
              aria-orientation="vertical"
              aria-valuemin={workbenchLayoutConstraints.chatMinWidth}
              aria-valuemax={maxMountedAppChatWidth(
                workbenchContainerWidth,
                effectiveWorkbenchLayout.filesWidth,
                effectiveDirectoryCollapsed,
                workbenchLayoutConstraints,
              )}
              aria-valuenow={effectiveWorkbenchLayout.chatWidth}
              tabIndex={0}
              onPointerDown={(event) => beginWorkbenchResize("chat", event)}
              onKeyDown={(event) => adjustWorkbenchLayoutWithKeyboard("chat", event)}
            />
          ) : undefined
        }
        chat={
          props.chat ? (
            <aside className="mounted-app-chat-pane" aria-label={t("mountedApp.chatLabel", { title: props.title })}>
              {props.chat}
            </aside>
          ) : undefined
        }
      />
 );
}
function resolveMountedAppWorkbenchLayoutConstraints(
  layoutMode: MountedAppWorkbenchLayoutMode,
  containerWidth: number,
): MountedAppWorkbenchLayoutConstraints {
  if (layoutMode !== "embedded") return STANDARD_MOUNTED_APP_WORKBENCH_CONSTRAINTS;
  // Before the first measurement, prefer the safer wide profile; layout measurement runs before paint.
  return containerWidth > 0 && containerWidth <= COMPACT_EMBEDDED_APP_WORKBENCH_MAX_WIDTH
    ? COMPACT_EMBEDDED_APP_WORKBENCH_CONSTRAINTS
    : WIDE_EMBEDDED_APP_WORKBENCH_CONSTRAINTS;
}

function maxMountedAppFilesWidth(
  containerWidth: number,
  chatWidth: number,
  chatOpen: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): number {
  if (!containerWidth) return constraints.filesMaxWidth;
  const chatReserve = chatOpen ? chatWidth + constraints.resizeHandleWidth : 0;
  const available = containerWidth - chatReserve - constraints.previewWidthReserve;
  return Math.max(constraints.filesMinWidth, Math.min(constraints.filesMaxWidth, available));
}

function maxMountedAppFilesWidthWhenChatYields(
  containerWidth: number,
  chatOpen: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): number {
  return maxMountedAppFilesWidth(containerWidth, constraints.chatMinWidth, chatOpen, constraints);
}

function maxMountedAppChatWidth(
  containerWidth: number,
  filesWidth: number,
  directoryCollapsed: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): number {
  if (!containerWidth) return constraints.chatMaxWidth;
  const directoryReserve = directoryCollapsed ? 0 : filesWidth;
  const available = containerWidth - directoryReserve - constraints.previewWidthReserve - constraints.resizeHandleWidth;
  return Math.max(constraints.chatMinWidth, Math.min(constraints.chatMaxWidth, available));
}

function mountedAppWorkbenchWidth(workbench: HTMLElement | null): number {
  return workbench?.clientWidth ?? 0;
}

function constrainMountedAppWorkbenchLayout(
  preferredLayout: MountedAppWorkbenchLayoutState,
  containerWidth: number,
  directoryCollapsed: boolean,
  chatOpen: boolean,
  constraints: MountedAppWorkbenchLayoutConstraints,
): MountedAppWorkbenchLayoutState {
  // Window constraints preserve the user's left-side file width first; chat yields until its minimum.
  const filesWidth = clamp(
    preferredLayout.filesWidth,
    constraints.filesMinWidth,
    maxMountedAppFilesWidthWhenChatYields(containerWidth, chatOpen, constraints),
  );
  const chatWidth = clamp(
    preferredLayout.chatWidth,
    constraints.chatMinWidth,
    maxMountedAppChatWidth(containerWidth, filesWidth, directoryCollapsed, constraints),
  );
  return {
    filesWidth: Math.round(filesWidth),
    chatWidth: Math.round(chatWidth),
  };
}
