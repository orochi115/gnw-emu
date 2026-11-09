import { readFile } from "node:fs/promises";
const [endpointFile, method = "automation.capabilities", json = "{}"] =
  process.argv.slice(2);
try {
  if (!endpointFile)
    throw new Error(
      "Usage: ui-cli.js UserData/automation.json METHOD [JSON_PARAMS]",
    );
  const endpoint = JSON.parse(await readFile(endpointFile, "utf8"));
  const url = new URL(endpoint.url);
  if (
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/rpc" ||
    url.protocol !== "http:"
  )
    throw new Error("Invalid local endpoint");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: JSON.parse(json),
    }),
    signal: AbortSignal.timeout(65000),
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}; verify application instance`);
  const reply = (await response.json()) as any;
  process.stdout.write(JSON.stringify(reply) + "\n");
  if (reply.error) process.exitCode = 1;
} catch (error) {
  process.stderr.write((error as Error).message + "\n");
  process.exitCode = 1;
}
