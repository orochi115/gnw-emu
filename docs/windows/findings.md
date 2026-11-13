Host: Windows 11, SSH access working, Node 24.20.0 and Python 3.13.15 present. No MSYS2 in usual locations.
Parent repository: gnw-emu, clean except existing .superpowers. gwemu pinned 57b2b378; manager 9ef9cea.
Build requires Windows executable/venv naming and runtime DLLs. Session manager is explicitly POSIX-only; Windows needs dedicated transport and private directory semantics.
Bootstrap location toolchains/msys64, MSYS2 base pinned 20260927 SHA256 ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322. Selected mirror TUNA. Actual package set currently GCC 16.2, Python 3.14, Ninja 1.13.2, CMake 4.4.5. Native Windows Python 3.13 remains used for firmware/manager packages (wheel availability).
