import { configureFrontend, type FrontendHandle, type FrontendOptions } from './host';

export type { FrontendBootstrap, FrontendHandle, FrontendOptions } from './host';

let mounted = false;

/** Mount the complete application. One frontend instance owns the document. */
export async function mountFrontend(element: HTMLElement, options: FrontendOptions): Promise<FrontendHandle> {
  if (mounted) throw new Error('frontend_already_mounted');
  if (!element.isConnected) throw new Error('frontend_mount_element_detached');
  configureFrontend(options);
  mounted = true;
  try {
    // Storage, theme and API clients initialize after the host supplies their identity.
    const { mountApplication } = await import('./application');
    const application = await mountApplication(element);
    let disposed = false;
    return { dispose() {
      if (disposed) return;
      disposed = true;
      application.dispose();
      mounted = false;
    } };
  } catch (error) {
    mounted = false;
    throw error;
  }
}
