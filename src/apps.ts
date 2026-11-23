/** An app the owner can open from the console. */
export interface AppSummary {
  id: string;
  name: string;
  /** Where the app opens: an https address, or a path of this origin. */
  url: string;
  /** The app's icon, a path of this origin (the console loads images from nowhere else). Without it the console draws the name's first letter. */
  icon?: string;
}

/**
 * Where the owner's apps come from. Mau has no app service of its own: a deployment that has one gives it here
 * (`createMau`'s dependencies), and `GET /_mau/v1/apps` answers from it.
 */
export interface AppDirectory {
  list(owner: string): AppSummary[] | Promise<AppSummary[]>;
}

const path = (value: unknown) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : undefined;
const address = (value: unknown) => {
  if (path(value)) return value as string;
  try { return typeof value === "string" && new URL(value).protocol === "https:" ? value : undefined; } catch { return undefined; }
};

/** What `GET /_mau/v1/apps` answers: only entries with an id, a name and an address the console may open. */
export async function listApps(directory: AppDirectory | undefined, owner: string): Promise<{ configured: boolean; data: AppSummary[] }> {
  if (!directory) return { configured: false, data: [] };
  const data = (await directory.list(owner)).flatMap((app): AppSummary[] => {
    const url = address(app?.url), icon = path(app?.icon);
    return typeof app?.id === "string" && app.id && typeof app.name === "string" && app.name && url
      ? [{ id: app.id, name: app.name, url, ...(icon ? { icon } : {}) }] : [];
  });
  return { configured: true, data };
}
