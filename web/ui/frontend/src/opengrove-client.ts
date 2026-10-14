import { frontendFetch } from "./host";
import { createOpenGroveClient } from "@opengrove/client";
import { apiUrl } from "./api-base";
import { bridgeHeaders } from "./bridge-headers";

export const openGroveClient = createOpenGroveClient({
  baseUrl: apiUrl("/"),
  credentials: "include",
  fetch: frontendFetch,
  headers: () => bridgeHeaders(false),
});
