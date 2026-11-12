import { parseArgs } from "node:util";
import { compareKernels } from "./kernel-comparison";

try {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      legacy: { type: "string" },
      gwemu: { type: "string" },
      output: { type: "string" },
      seconds: { type: "string", default: "3" },
      buttons: { type: "string" },
    },
  });
  if (!values.profile || !values.legacy || !values.gwemu || !values.output)
    throw new Error(
      "Usage: compare-kernels --profile file.gnw.json --legacy binary --gwemu binary --output NEW-directory [--seconds 3]",
    );
  const report = await compareKernels({
    profilePath: values.profile,
    legacy: values.legacy,
    gwemu: values.gwemu,
    outputDirectory: values.output,
    seconds: Number(values.seconds),
    buttons: values.buttons,
  });
  for (const run of report.runs)
    console.log(
      `${run.kernel}: ${run.status}${run.error ? ` (${run.error})` : ""}`,
    );
  console.log(
    `Source unchanged: ${report.sourceUnchanged}; report: ${values.output}/report.json`,
  );
  if (
    !report.sourceUnchanged ||
    report.runs.some((run) => run.status === "failed")
  )
    process.exitCode = 1;
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
