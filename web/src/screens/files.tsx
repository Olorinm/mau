import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DirectoryPanel,
  DirectoryTree,
  FilePanel,
  FilePreview,
  InlineNotice,
  InlineSelect,
  LoadingSurface,
  WorkspaceWorkbenchLayout,
  type DirectoryTreeNode,
  type FilePreviewKind,
} from "@olorinm/agent-frontend";
import { Button, EmptyState } from "@olorinm/agent-ui/app";
import { request, ApiError, safeExternalUrl } from "../api/http";
import type { Session } from "../api/session";
import { useI18n, errorMessage } from "../i18n";

export function FilesScreen({ session }: { session: Session }) {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const [selected, setSelected] = useState("");
  const [path, setPath] = useState("");
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>({});
  const spaces = useQuery({
    queryKey: ["workspaces", session.owner],
    queryFn: () =>
      request<{ data: Array<{ id: string; name: string }> }>(
        "/_mau/v1/workspaces",
        { token: session.token },
      ),
  });
  useEffect(() => {
    if (!selected && spaces.data?.data.length)
      setSelected(spaces.data.data[0]!.id);
  }, [spaces.data, selected]);
  const files = useQuery({
    queryKey: ["workspace-files", session.owner, selected],
    enabled: !!selected,
    queryFn: () =>
      request<{ data: Array<{ path: string; size: number }> }>(
        `/_mau/v1/workspaces/${encodeURIComponent(selected)}/files`,
        { token: session.token },
      ),
  });
  const preview = useQuery({
    queryKey: ["workspace-preview", session.owner, selected, path],
    enabled: !!selected && !!path,
    queryFn: async ({ signal }) => {
      const result = await request<{ url: string }>(
        `/_mau/v1/workspaces/${encodeURIComponent(selected)}/download?path=${encodeURIComponent(path)}`,
        { token: session.token },
      );
      const url = safeExternalUrl(result.url);
      if (!url) throw new ApiError("invalid_response", 200);
      if (new URL(url, location.href).origin !== location.origin)
        return { url, kind: undefined, content: undefined };
      const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
      const kind: FilePreviewKind | undefined = ["md", "mdx"].includes(
        extension,
      )
        ? "markdown"
        : [
              "txt",
              "json",
              "js",
              "ts",
              "tsx",
              "jsx",
              "css",
              "html",
              "yaml",
              "yml",
              "csv",
              "py",
              "sh",
              "log",
            ].includes(extension)
          ? "text"
          : ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)
            ? "image"
            : ["mp4", "webm", "mov"].includes(extension)
              ? "video"
              : ["mp3", "wav", "ogg", "m4a"].includes(extension)
                ? "audio"
                : extension === "pdf"
                  ? "pdf"
                  : undefined;
      let content: string | undefined;
      const size =
        files.data?.data.find((file) => file.path === path)?.size ?? Infinity;
      if ((kind === "text" || kind === "markdown") && size <= 1024 * 1024) {
        const response = await fetch(url, { signal, credentials: "omit" });
        if (!response.ok) throw new ApiError("request_failed", response.status);
        content = await response.text();
      }
      return { url, kind, content };
    },
  });
  const nodes = useMemo(() => {
    const roots: DirectoryTreeNode[] = [];
    for (const file of files.data?.data ?? []) {
      const parts = file.path.split("/").filter(Boolean);
      let siblings = roots;
      let prefix = "";
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i]!;
        prefix = prefix ? `${prefix}/${name}` : name;
        let node = siblings.find((node) => node.path === prefix);
        if (!node) {
          node = {
            id: prefix,
            path: prefix,
            name,
            kind: i === parts.length - 1 ? "file" : "folder",
            children: [],
          };
          siblings.push(node);
        }
        siblings = node.children!;
      }
    }
    return roots;
  }, [files.data]);
  const error = spaces.error ?? files.error ?? preview.error;
  const noop = () => {};
  return (
    <WorkspaceWorkbenchLayout
      className="mau-file-workbench"
      detailOpen={!!path}
      onOpenDirectory={() => setPath("")}
      directory={
        <DirectoryPanel
          title={zh ? "文件" : "Files"}
          actions={
            <Button onClick={() => void files.refetch()}>
              {t("common.retry")}
            </Button>
          }
          search={
            spaces.data?.data.length ? (
              <InlineSelect
                value={selected}
                options={spaces.data.data.map((space) => ({
                  id: space.id,
                  label: space.name,
                }))}
                onChange={(id) => {
                  setSelected(id);
                  setPath("");
                }}
              />
            ) : undefined
          }
          status={
            error ? (
              <InlineNotice tone="error">
                {errorMessage(
                  t,
                  error instanceof ApiError ? error.code : "request_failed",
                )}
              </InlineNotice>
            ) : undefined
          }
        >
          {spaces.isPending || (selected && files.isPending) ? (
            <LoadingSurface />
          ) : nodes.length ? (
            <DirectoryTree
              nodes={nodes}
              labels={{
                more: zh ? "更多" : "More",
                newFile: zh ? "新建文件" : "New file",
                newFolder: zh ? "新建文件夹" : "New folder",
                rename: zh ? "重命名" : "Rename",
                delete: zh ? "删除" : "Delete",
              }}
              openPaths={openPaths}
              dragSourcePath=""
              dropTargetPath=""
              menuState={null}
              canCreateIn={() => false}
              canModify={() => false}
              canDrag={() => false}
              isActive={(node) => node.path === path}
              onToggleFolder={(path, open) =>
                setOpenPaths((values) => ({ ...values, [path]: !open }))
              }
              onSelectFile={(node) => setPath(node.path)}
              onCancelRename={noop}
              onCreateFile={noop}
              onCreateFolder={noop}
              onDeleteEntry={noop}
              onDrop={noop}
              onOpenMenu={noop}
              onRenameEntry={noop}
              onSetDragSource={noop}
              onSetDropTarget={noop}
              onStartRename={noop}
            />
          ) : (
            <EmptyState
              illustration="sprout"
              title={zh ? "暂无共享文件" : "No shared files"}
            />
          )}
        </DirectoryPanel>
      }
      preview={
        path ? (
          <FilePanel
            title={path}
            loading={preview.isPending}
            actions={
              preview.data ? (
                <a
                  href={preview.data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {zh ? "下载" : "Download"}
                </a>
              ) : null
            }
          >
            {preview.data?.kind &&
            (!(
              preview.data.kind === "text" || preview.data.kind === "markdown"
            ) ||
              preview.data.content !== undefined) ? (
              <FilePreview
                name={path}
                kind={preview.data.kind}
                src={preview.data.url}
                {...(preview.data.content !== undefined
                  ? { content: preview.data.content }
                  : {})}
              />
            ) : preview.isSuccess ? (
              <InlineNotice title={path}>
                {zh
                  ? "此文件暂不支持在线预览，可下载查看。"
                  : "Download this file to view it."}
              </InlineNotice>
            ) : null}
          </FilePanel>
        ) : (
          <EmptyState
            illustration="sprout"
            title={zh ? "选择文件" : "Select a file"}
          />
        )
      }
    />
  );
}
