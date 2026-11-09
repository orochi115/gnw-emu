#ifndef GNW_SESSION_LOCK_H
#define GNW_SESSION_LOCK_H
#include "qapi/error.h"
int gnw_session_lock_acquire(const char *path, Error **errp);
#endif
