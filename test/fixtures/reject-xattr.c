#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <string.h>
#include <sys/types.h>
#include <sys/xattr.h>

extern char *program_invocation_short_name;
static int reject(const char *name) {
  if (!strcmp(program_invocation_short_name, "cp") && !strcmp(name, "user.pi-apply-edits-test")) {
    errno = EOPNOTSUPP;
    return 1;
  }
  return 0;
}
int fsetxattr(int fd, const char *name, const void *value, size_t size, int flags) {
  if (reject(name)) return -1;
  return ((int (*)(int, const char *, const void *, size_t, int))dlsym(RTLD_NEXT, "fsetxattr"))(fd, name, value, size, flags);
}
int setxattr(const char *path, const char *name, const void *value, size_t size, int flags) {
  if (reject(name)) return -1;
  return ((int (*)(const char *, const char *, const void *, size_t, int))dlsym(RTLD_NEXT, "setxattr"))(path, name, value, size, flags);
}
int lsetxattr(const char *path, const char *name, const void *value, size_t size, int flags) {
  if (reject(name)) return -1;
  return ((int (*)(const char *, const char *, const void *, size_t, int))dlsym(RTLD_NEXT, "lsetxattr"))(path, name, value, size, flags);
}
