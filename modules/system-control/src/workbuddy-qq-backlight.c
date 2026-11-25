#include <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*SetBrightnessFn)(CGDirectDisplayID display, float brightness);
typedef int (*GetBrightnessFn)(CGDirectDisplayID display, float *brightness);

static void usage(const char *name) {
  fprintf(stderr, "usage: %s list|get|set <0.0-1.0>\n", name);
}

static int load_display_services(SetBrightnessFn *set_fn, GetBrightnessFn *get_fn) {
  void *handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY);
  if (!handle) {
    fprintf(stderr, "failed to load DisplayServices: %s\n", dlerror());
    return 1;
  }

  *set_fn = (SetBrightnessFn)dlsym(handle, "DisplayServicesSetBrightness");
  *get_fn = (GetBrightnessFn)dlsym(handle, "DisplayServicesGetBrightness");
  if (!*set_fn || !*get_fn) {
    fprintf(stderr, "failed to resolve DisplayServices brightness symbols\n");
    return 1;
  }

  return 0;
}

static int get_online_displays(CGDirectDisplayID *displays, uint32_t max_displays, uint32_t *count) {
  CGError error = CGGetOnlineDisplayList(max_displays, displays, count);
  if (error != kCGErrorSuccess) {
    fprintf(stderr, "CGGetOnlineDisplayList failed: %d\n", error);
    return 1;
  }
  return 0;
}

static uint32_t collect_builtin_displays(CGDirectDisplayID *builtins, uint32_t max_builtins) {
  CGDirectDisplayID displays[32];
  uint32_t count = 0;
  uint32_t builtin_count = 0;
  if (get_online_displays(displays, 32, &count) != 0) {
    return 0;
  }

  for (uint32_t i = 0; i < count && builtin_count < max_builtins; i++) {
    if (CGDisplayIsBuiltin(displays[i])) {
      builtins[builtin_count++] = displays[i];
    }
  }

  return builtin_count;
}

static int list_displays(GetBrightnessFn get_fn) {
  CGDirectDisplayID displays[32];
  uint32_t count = 0;
  if (get_online_displays(displays, 32, &count) != 0) {
    return 1;
  }

  for (uint32_t i = 0; i < count; i++) {
    float brightness = -1.0f;
    int status = get_fn(displays[i], &brightness);
    printf("display=0x%x builtin=%s main=%s active=%s brightness=",
           displays[i],
           CGDisplayIsBuiltin(displays[i]) ? "yes" : "no",
           CGDisplayIsMain(displays[i]) ? "yes" : "no",
           CGDisplayIsActive(displays[i]) ? "yes" : "no");
    if (status == 0) {
      printf("%.4f\n", brightness);
    } else {
      printf("unavailable(status=%d)\n", status);
    }
  }

  return 0;
}

static int get_builtin_brightness(GetBrightnessFn get_fn) {
  CGDirectDisplayID builtins[8];
  uint32_t count = collect_builtin_displays(builtins, 8);
  if (count == 0) {
    fprintf(stderr, "no online built-in display found\n");
    return 2;
  }

  float brightness = -1.0f;
  int status = get_fn(builtins[0], &brightness);
  if (status != 0) {
    fprintf(stderr, "failed to get built-in display brightness: %d\n", status);
    return 1;
  }
  printf("%.4f\n", brightness);
  return 0;
}

static int set_builtin_brightness(SetBrightnessFn set_fn, float target) {
  CGDirectDisplayID builtins[8];
  uint32_t count = collect_builtin_displays(builtins, 8);
  if (count == 0) {
    fprintf(stderr, "no online built-in display found\n");
    return 2;
  }

  int had_error = 0;
  for (uint32_t i = 0; i < count; i++) {
    int status = set_fn(builtins[i], target);
    if (status != 0) {
      fprintf(stderr, "failed to set built-in display 0x%x brightness: %d\n", builtins[i], status);
      had_error = 1;
    } else {
      printf("set built-in display 0x%x brightness to %.4f\n", builtins[i], target);
    }
  }

  return had_error ? 1 : 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    usage(argv[0]);
    return 64;
  }

  SetBrightnessFn set_fn = NULL;
  GetBrightnessFn get_fn = NULL;
  if (load_display_services(&set_fn, &get_fn) != 0) {
    return 1;
  }

  if (strcmp(argv[1], "list") == 0) {
    return list_displays(get_fn);
  }

  if (strcmp(argv[1], "get") == 0) {
    return get_builtin_brightness(get_fn);
  }

  if (strcmp(argv[1], "set") == 0) {
    if (argc < 3) {
      usage(argv[0]);
      return 64;
    }
    char *end = NULL;
    float target = strtof(argv[2], &end);
    if (end == argv[2] || *end != '\0' || !isfinite(target) || target < 0.0f || target > 1.0f) {
      fprintf(stderr, "brightness must be a number between 0.0 and 1.0\n");
      return 64;
    }
    return set_builtin_brightness(set_fn, target);
  }

  usage(argv[0]);
  return 64;
}
