/** QEMU comma-separated options escape literal commas by doubling them. */
export function qemuEscape(value: string) {
  return value.replaceAll(",", ",,");
}
