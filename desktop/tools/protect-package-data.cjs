const { lstat } = require("node:fs/promises");
const { join } = require("node:path");

// electron-builder clears appOutDir after beforePack, including portable saves.
module.exports = async ({ appOutDir }) => {
  const data = join(appOutDir, "UserData");
  try {
    await lstat(data);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Refusing to clear package output containing UserData: ${data}. ` +
      "Choose a new --config.directories.output directory, or move the whole running package to a separate directory before rebuilding.",
  );
};
