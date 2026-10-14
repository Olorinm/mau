import { mountFrontend } from "./index";
import "./styles.css";

void mountFrontend(document.getElementById("root")!, {
  apiBase: new URL("/api/", location.href).href,
  productName: "OpenGrove",
  storageNamespace: "opengrove",
}).catch(error => {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = error instanceof Error ? error.message : String(error);
  document.getElementById("root")!.replaceChildren(message);
});
