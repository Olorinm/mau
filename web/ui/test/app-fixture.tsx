import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatProvider } from "@olorinm/agent-ui";
import {
  AppIcon,
  Button,
  ConfirmProvider,
  ConsentDialog,
  DetailHero,
  FeaturedCard,
  FeaturedGrid,
  ListRow,
  ProductIcon,
  SearchField,
  SegmentedControl,
  SelectMenu,
  SettingsDialog,
  SettingsPage,
  SettingsSection,
  TextButton,
  Dialog,
  DialogContent,
  DialogTitle,
  EmployeeAvatar,
  EmptyState,
  ObjectSettingsRow,
  ObjectSettingsSection,
  ProductStatus,
  ToastProvider,
  useConfirm,
  useToast,
} from "@olorinm/agent-ui/app";
import "@olorinm/agent-ui/app.css";

const copy: Record<string, string> = {
  "common.cancel": "取消",
  "common.confirm": "确认",
  "toast.close": "关闭通知",
  "toast.regionLabel": "通知",
};

function SettingsFixture() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<string | null>("apps");
  const [detail, setDetail] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"available" | "connected">("available");
  const [setting, setSetting] = useState<"allow" | "ask" | "deny">("ask");
  const [consent, setConsent] = useState(false);
  const [connected, setConnected] = useState("no");
  const icon = <AppIcon size="card"><ProductIcon name="globe" /></AppIcon>;
  return (
    <>
      <Button onClick={() => setOpen(true)}>Settings</Button>
      <output aria-label="Connected">{connected}</output>
      <SettingsDialog open={open} onOpenChange={setOpen} title="Settings" closeLabel="Close settings" backLabel="Back"
        selectedId={section} onSelect={(id) => { setSection(id); setDetail(false); }}
        items={[
          { id: "general", label: "General", icon: <ProductIcon name="settings" /> },
          { id: "apps", label: "Connectors", icon: <ProductIcon name="apps" /> },
          { id: "logout", label: "Sign out", icon: <ProductIcon name="logout" />, footer: true, onSelect: () => setConnected("signed-out") },
        ]}>
        {section === "general" ? <SettingsPage title="General"><SettingsSection><ListRow title="Language" /></SettingsSection></SettingsPage>
          : detail ? <SettingsPage onBack={() => setDetail(false)} backLabel="All connectors" hero={<DetailHero icon={icon} title="Browser" subtitle="Open pages" />}>
            <SettingsSection title="Write access" note="Ask is refused in scheduled work.">
              <ListRow title="Upload files" trailing={<SelectMenu label="Upload files" value={setting} onChange={setSetting}
                options={[{ value: "allow", label: "Allow" }, { value: "ask", label: "Ask" }, { value: "deny", label: "Don't allow" }]} />} />
              <ListRow title="Manage labels" muted subtitle="Needs more access" trailing={<TextButton>Add</TextButton>} />
            </SettingsSection>
            <output aria-label="Upload setting">{setting}</output>
          </SettingsPage>
          : <SettingsPage title="Connectors">
            <SearchField value={query} onChange={setQuery} placeholder="Search" clearLabel="Clear search" />
            <SegmentedControl label="Connector categories" value={tab} onChange={setTab}
              options={[{ value: "available", label: "Available" }, { value: "connected", label: "Connected", badge: 1 }]} />
            <SettingsSection title="Featured" panel={false}>
              <FeaturedGrid><FeaturedCard icon={icon} title="Browser" description="Open pages" onClick={() => setDetail(true)} /></FeaturedGrid>
            </SettingsSection>
            <SettingsSection title="Tools">
              {"browser".includes(query.toLowerCase()) ? <ListRow icon={<AppIcon><ProductIcon name="globe" /></AppIcon>} title="Browser" ariaLabel="Browser"
                onClick={() => setDetail(true)} trailing={<TextButton onClick={() => setConsent(true)}>Connect</TextButton>} /> : null}
            </SettingsSection>
          </SettingsPage>}
      </SettingsDialog>
      <ConsentDialog open={consent} onOpenChange={setConsent} icon={icon} title="Browser" description="Agents can use the browser"
        closeLabel="Close" confirmLabel="Continue" cancelLabel="Cancel" onConfirm={() => { setConnected("yes"); setConsent(false); }}
        items={[{ icon: <ProductIcon name="eye" />, title: "What it can read", body: "Pages you open." }]}
        footnote={<a href="https://example.test/privacy">Privacy policy</a>} />
    </>
  );
}

function Fixture() {
  const confirm = useConfirm();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("");
  return (
    <main className="agent-app">
      <ObjectSettingsSection title="Agents">
        <ObjectSettingsRow
          leading={<EmployeeAvatar seed="agent-1" fallbackName="Helper" />}
          title="Helper"
          value={<ProductStatus tone="success" label="Ready" />}
          onClick={() => setOpen(true)}
        />
      </ObjectSettingsSection>
      <EmptyState illustration="sprout" title="No channels" />
      <Button
        onClick={async () =>
          setResult(String(await confirm({ title: "Destroy environment?", body: "Workspace files are removed.", danger: true })))
        }
      >
        Destroy
      </Button>
      <Button onClick={() => toast({ kind: "success", title: "Agent paused", duration: 0 })}>Notify</Button>
      <Button
        onClick={() => {
          const root = document.documentElement;
          root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
        }}
      >
        Theme
      </Button>
      <output aria-label="Confirm result">{result}</output>
      <SettingsFixture />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Helper</DialogTitle>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogContent>
      </Dialog>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChatProvider translate={(key) => copy[key] ?? key}>
    <ConfirmProvider>
      <ToastProvider>
        <Fixture />
      </ToastProvider>
    </ConfirmProvider>
  </ChatProvider>,
);
