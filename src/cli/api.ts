import { readFileSync } from "node:fs";
import { mau, router, type Method } from "./client.js";
import { fail, text, type Command } from "./command.js";

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const apiCommands: Command[] = [
  { path: ["api"], args: "[METHOD] [PATH]", summary: "Without arguments: every HTTP route of the service (method, path, summary, body schema). With METHOD and PATH: call one and print its JSON answer.",
    options: { data: { type: "string", value: "JSON", help: "The request body." }, "data-file": { type: "string", value: "FILE", help: "A file with the request body." } },
    run: async ({ args, options, client }) => {
      const [method, path] = args, data = text(options.data), file = text(options["data-file"]);
      if (method === undefined) return data === undefined && file === undefined ? client().get(mau + "/reference") : fail("data_requires_method_and_path");
      if (path === undefined) fail("path_required");
      if (!methods.includes(method)) fail("invalid_method", { methods });
      if (![mau, router].some(root => path!.startsWith(root + "/"))) fail("invalid_api_path", { roots: [mau, router] });
      if (data !== undefined && file !== undefined) fail("choose_data_or_data_file");
      let body: unknown;
      try { body = data !== undefined ? JSON.parse(data) : file !== undefined ? JSON.parse(readFileSync(file, "utf8")) : undefined; }
      catch { fail("invalid_json_body"); }
      // A route that takes a body and needs nothing in it takes the empty object.
      return client().request(method as Method, path!, body ?? (method === "GET" || method === "DELETE" ? undefined : {}), 300_000);
    } },
];
