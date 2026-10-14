import React, { type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NetworkAuthorizationProvider } from "./components/rooms/network-authorization-provider";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./styles.css";
import { App } from "./app";
import { CloudAuthLoadingScreen } from "./components/app-shell/app-gates";
import { ConfirmProvider } from "./components/ui/confirm-dialog";
import { ToastProvider } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyDocumentIconStyle } from "./appearance";
import { applyDocumentLanguage, rawDiagnosticText, translate } from "./i18n";
import { startDocumentThemeSync } from "./theme";
import { loadClientBootstrapForRuntime } from "./runtime/client-bootstrap";
import { readDesktopApi, readDesktopBridgeStartupState, type OpenGroveDesktopApi } from "./desktop-api";
import { desktopBridgeReadyForBootstrap } from "./runtime/desktop-bootstrap-policy";

import type { FrontendHandle } from "./host";
class RootErrorBoundary extends React.Component<{ children: ReactNode }, { error: Error | undefined }> {
  state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[opengrove-ui] root render failed", {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <main className="app-fatal-error" role="alert">
        <div>
          <strong>{translate("shell.rootRenderFailedTitle")}</strong>
          <p>{translate("shell.rootRenderFailedCopy")}</p>
          <code>{rawDiagnosticText(this.state.error.message)}</code>
        </div>
      </main>
    );
  }
}

export async function mountApplication(element: HTMLElement): Promise<FrontendHandle> {
  applyDocumentLanguage();
  const stopTheme = startDocumentThemeSync();
  applyDocumentIconStyle();
  const root = ReactDOM.createRoot(element);
  const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 3_000 } } });
  let router: ReturnType<typeof createBrowserRouter> | undefined;
  function render(content: ReactNode) {
    root.render(<React.StrictMode><RootErrorBoundary><QueryClientProvider client={queryClient}>
      <TooltipProvider><ToastProvider><NetworkAuthorizationProvider><ConfirmProvider>
        {content}
      </ConfirmProvider></NetworkAuthorizationProvider></ToastProvider></TooltipProvider>
    </QueryClientProvider></RootErrorBoundary></React.StrictMode>);
  }
  function dispose() {
    root.unmount();
    router?.dispose();
    void queryClient.cancelQueries();
    queryClient.clear();
    stopTheme();
  }
  try {
    const desktop = readDesktopApi();
    if (!desktopBridgeReadyForBootstrap(desktop)) render(<DesktopBootstrapGate desktop={desktop!} />);
    await loadClientBootstrapForRuntime(desktop);
    router = createBrowserRouter([{ path: "*", element: <App /> }]);
    render(<RouterProvider router={router} />);
    return { dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
function DesktopBootstrapGate({ desktop }: { desktop: OpenGroveDesktopApi }) {
  const [startupState, setStartupState] = React.useState(readDesktopBridgeStartupState(desktop));
  React.useEffect(() => desktop.onBridgeStartupStateChange?.(setStartupState), [desktop]);
  return (
    <CloudAuthLoadingScreen
      mode="desktop"
      startupState={startupState}
      onRetry={() => {
        void desktop.retryBridgeStartup?.();
      }}
    />
  );
}
