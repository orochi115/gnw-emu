/* The emulator, not its launcher, holds the lock for its full lifetime. */
#include "qemu/osdep.h"
#include "qemu/cutils.h"
#include "gnw_session_lock.h"
int gnw_session_lock_acquire(const char *path, Error **errp)
{
    int fd;
    if (!path) { return -1; }
    fd = open(path, O_RDWR | O_CREAT | O_BINARY, 0600);
    if (fd < 0) { error_setg_errno(errp, errno, "gnw: cannot open session lock"); return -1; }
#ifdef _WIN32
    OVERLAPPED ov = { 0 };
    if (!LockFileEx((HANDLE)_get_osfhandle(fd), LOCKFILE_EXCLUSIVE_LOCK |
                    LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) {
        error_setg(errp, "gnw: session lock occupied (Windows error %lu)", GetLastError());
        close(fd); return -1;
    }
#else
    if (qemu_lock_fd(fd, 0, 1, true) < 0) {
        error_setg(errp, "gnw: session lock occupied"); close(fd); return -1;
    }
#endif
    return fd;
}
