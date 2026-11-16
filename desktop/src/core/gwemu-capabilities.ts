import { spawnOwnedNative } from "./owned-process";
import { QmpClient } from "./qmp-client";
import { UserError } from "../shared/user-error";

/** Read-only machine properties are omitted by -M help. Never open ROMs to probe them. */
async function probe(
  binary: string,
  env: NodeJS.ProcessEnv,
  machine: string,
  inspect: (qmp: QmpClient) => Promise<void>,
) {
  const qmp = new QmpClient();
  let child: ReturnType<typeof spawnOwnedNative> | undefined;
  let stderr = "",
    exitDetail = "",
    phase = "connect";
  let exit: Promise<void> | undefined;
  const timed = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_r, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native capability probe timed out")),
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
    child = spawnOwnedNative(
      binary,
      [
        "-M",
        machine,
        "-S",
        "-display",
        "none",
        "-audiodev",
        "none,id=capability-probe",
        "-global",
        "gnw-h7b0-soc.extflash-chip=c2-25-34",
        "-qmp",
        `tcp:127.0.0.1:${port},server=off`,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    exit = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => {
        exitDetail = `exit=${code}; signal=${signal}`;
        resolve();
      });
    });
    exit.catch(() => {});
    await timed(
      Promise.race([
        qmp.ready,
        exit.then(() => {
          throw new Error("Native process exited before QMP connection");
        }),
      ]),
      5000,
    );
    phase = "inspect";
    await inspect(qmp);
  } catch (error) {
    if (error instanceof UserError && error.code === "error.kernelBuild")
      throw error;
    throw new UserError("error.kernelConnection", {
      phase: `${machine}:${phase}`,
      detail: `${String(error)}; ${exitDetail}; ${stderr}`.slice(-4096),
    });
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

export async function requireSupplyCapabilities(
  binary: string,
  env: NodeJS.ProcessEnv,
) {
  await probe(binary, env, "none", async (qmp) => {
    const properties: unknown = await qmp.command(
      "qom-list-properties",
      { typename: "gnw-h7b0-machine" },
      3000,
    );
    if (
      !hasProperties(properties, { "battery-present": "bool", powered: "bool" })
    )
      throw new UserError("error.kernelBuild");
  });
}
function hasProperties(value: unknown, expected: Record<string, string>) {
  return (
    Array.isArray(value) &&
    Object.entries(expected).every(([name, type]) =>
      value.some(
        (property) =>
          property &&
          typeof property === "object" &&
          property.name === name &&
          property.type === type,
      ),
    )
  );
}
async function requireRejection(work: Promise<unknown>, reason: string) {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error && error.message.includes(reason)) return;
    throw new UserError("error.kernelBuild");
  }
  throw new UserError("error.kernelBuild");
}
/** QMP metadata omits access flags. A paused anonymous board proves them without
 * mounting firmware, a session, a drive or opening a snapshot file. */
export async function requireSavestateCapabilities(
  binary: string,
  env: NodeJS.ProcessEnv,
) {
  await probe(binary, env, "none", async (qmp) => {
    const properties: unknown = await qmp.command(
      "qom-list-properties",
      { typename: "gnw-h7b0-machine" },
      3000,
    );
    if (
      !hasProperties(properties, {
        "instant-states": "bool",
        "state-id": "string",
        "savestate-support": "string",
        "save-state": "string",
        "load-state": "string",
      })
    )
      throw new UserError("error.kernelBuild");
  });
  await probe(
    binary,
    env,
    "gnw-h7b0,instant-states=on,state-id=capability-probe,audiodev=capability-probe",
    async (qmp) => {
      if (
        (await qmp.command(
          "qom-get",
          { path: "/machine", property: "savestate-support" },
          3000,
        )) !== ""
      )
        throw new UserError("error.kernelBuild");
      await requireRejection(
        qmp.command(
          "qom-set",
          {
            path: "/machine",
            property: "savestate-support",
            value: "relative-capability-probe",
          },
          3000,
        ),
        "not writable",
      );
      for (const property of ["save-state", "load-state"]) {
        await requireRejection(
          qmp.command("qom-get", { path: "/machine", property }, 3000),
          "not readable",
        );
        await requireRejection(
          qmp.command(
            "qom-set",
            { path: "/machine", property, value: "relative-capability-probe" },
            3000,
          ),
          "State path must be absolute",
        );
      }
    },
  );
}
