/* Bounded buffers for GNW's in-flight peripheral transactions. */
#ifndef GNW_STATE_H
#define GNW_STATE_H
#include "migration/qemu-file.h"
#include "qapi/error.h"

static inline bool gnw_put_blob(QEMUFile *f, const uint8_t *data, uint32_t len,
                                uint32_t limit, Error **errp)
{
    if (len > limit || (len && !data)) {
        error_setg(errp, "GNW state buffer exceeds supported size");
        return false;
    }
    qemu_put_be32(f, len);
    if (len) {
        qemu_put_buffer(f, data, len);
    }
    return true;
}
static inline bool gnw_get_blob(QEMUFile *f, uint8_t **data, uint32_t *len,
                                uint32_t limit, Error **errp)
{
    uint32_t n = qemu_get_be32(f);
    if (n > limit || qemu_file_get_error(f)) {
        error_setg(errp, "Invalid GNW state buffer size");
        return false;
    }
    uint8_t *buf = g_malloc(MAX(n, 1));
    if (n && qemu_get_buffer(f, buf, n) != n) {
        g_free(buf);
        error_setg(errp, "Truncated GNW state buffer");
        return false;
    }
    g_free(*data);
    *data = buf;
    *len = n;
    return true;
}
#define GNW_STATE_BUFFERS(_info)                                               \
    {.name = "buffers",                                                        \
     .offset = 0,                                                              \
     .size = 0,                                                                \
     .info = &_info,                                                           \
     .flags = VMS_SINGLE}
#endif
