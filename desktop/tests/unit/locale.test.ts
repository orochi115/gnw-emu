import { expect, test } from "vitest";
import {
  initializeLocale,
  chooseLocale,
  t,
  resources,
  userMessage,
} from "../../src/shared/locale";
import { UserError } from "../../src/shared/user-error";
import { settingsSchema } from "../../src/core/schemas";
test("system language has explicit CLI then settings precedence and English fallback", () => {
  expect(chooseLocale("zh-TW", "system")).toBe("zh-CN");
  expect(chooseLocale("fr-FR", "system")).toBe("en");
  expect(chooseLocale("en-US", "zh-CN")).toBe("zh-CN");
  expect(chooseLocale("zh-CN", "zh-CN", "en")).toBe("en");
  expect(() => chooseLocale("en", "system", "invalid")).toThrow();
  expect(settingsSchema.parse({ formatVersion: 1 }).language).toBe("system");
});
test("catalogs cover identical keys and localize structured errors without changing path", () => {
  expect(Object.keys(resources.en.translation).sort()).toEqual(
    Object.keys(resources["zh-CN"].translation).sort(),
  );
  initializeLocale("en");
  expect(t("menu.file")).toBe("File");
  expect(
    userMessage(
      new UserError("error.imageRead", {
        field: "internalFlash",
        path: "/tmp/中文.bin",
      }),
    ),
  ).toBe("Internal Flash: Cannot read file /tmp/中文.bin");
  initializeLocale("zh-CN");
  expect(t("menu.file")).toBe("文件");
  expect(
    userMessage(
      new UserError("error.imageRead", {
        field: "internalFlash",
        path: "/tmp/中文.bin",
      }),
    ),
  ).toBe("内部 Flash：无法读取文件 /tmp/中文.bin");
});
