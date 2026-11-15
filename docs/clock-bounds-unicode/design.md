# Clock movement limits and Windows Unicode paths

User authorizes implementation on master first, then merge into special/windows-stock-dual and deliver a new ZIP. Existing portable-data layout and firmware confidentiality remain requirements.

Clock: reuse docking geometry as the containment rectangle (Windows full display; other platforms work area). Clamp custom drag candidates before moving, repair native move/resize events, and clamp scale/frame changes and restored placements. Choose target display from the candidate bounds so monitors remain reachable; cover negative origins. Oversized windows retain top-left access and are resized to fit when necessary without changing normal-window behavior. Avoid move-event recursion.

Unicode: trace with a real native regression using Chinese/emoji paths for profile, source images, session, lock and snapshot. Preserve UTF-8 argv with GLib Windows command-line decoding, use wide Win32 mapped-image APIs, and use GLib UTF-8 file opens for locks/snapshots. Inspect native SD file backend as the same path boundary. Prefer explicit Unicode APIs over short-name/junction aliases (which depend on filesystem settings) or system-wide locale changes. Rebuild clean pinned native source and update the master gitlink/provenance.

Acceptance: unit movement tests, real native Unicode session/save/restart/source-hash checks, actual Windows drag against every edge, existing clock acceptance, and both fixed-profile stock EXEs extracted under Chinese directories with relocation/saves. Then return a separate ZIP, verify CRC/SHA256 and original firmware hashes, and remove temporary scheduled tasks. No firmware BIN in commits.
