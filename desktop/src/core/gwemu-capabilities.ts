import { spawn } from "node:child_process";
import { QmpClient } from "./qmp-client";
import { UserError } from "../shared/user-error";

/** Read-only machine properties are omitted by -M help. Never open ROMs to probe them. */
export async function requireSupplyCapabilities(
  binary: string,
  env: NodeJS.ProcessEnv,
) {
  const qmp = new QmpClient();
  let child: ReturnType<typeof spawn> | undefined;
  let exit: Promise<void> | undefined;
  const timed = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_r, reject) => {
          timer = setTimeout(
            () => reject(new UserError("error.kernelBuild")),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const port = await qmp.listen();
    child = spawn(
      binary,
      [
        "-M",
        "none",
        "-S",
        "-display",
        "none",
        "-qmp",
        `tcp:127.0.0.1:${port},server=off`,
      ],
      { env, stdio: "ignore" },
    );
    exit = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", () => resolve());
    });
    exit.catch(() => {});
    await timed(
      Promise.race([
        qmp.ready,
        exit.then(() => {
          throw new UserError("error.kernelBuild");
        }),
      ]),
      3000,
    );
    const properties: unknown = await qmp.command(
      "qom-list-properties",
      { typename: "gnw-h7b0-machine" },
      3000,
    );
    if (
      !Array.isArray(properties) ||
      !["battery-present", "powered"].every((name) =>
        properties.some(
          (property) => property.name === name && property.type === "bool",
        ),
      )
    )
      throw new UserError("error.kernelBuild");
  } catch {
    throw new UserError("error.kernelBuild");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await qmp.command("quit", undefined, 500).catch(() => {});
      if (exit)
        await timed(exit, 1000).catch(async () => {
          child!.kill("SIGKILL");
          await timed(exit!, 3000).catch(() => {});
        });
    }
    await qmp.close();
  }
}
