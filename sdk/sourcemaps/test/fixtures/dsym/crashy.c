// Fixture for @ouo11y/sourcemaps' dSYM slicing tests (test/fixtures/dsym, built by gen.sh).
#include <stdio.h>

static int depth = 0;

__attribute__((noinline)) void crash_here(int *p) {
  depth++;
  *p = 42;
}

static inline __attribute__((always_inline)) void inlined_step(int *p) {
  depth += 2;
  crash_here(p);
}

__attribute__((noinline)) void level1(int *p) {
  inlined_step(p);
  depth--;
}

int main(int argc, char **argv) {
  level1(argc > 5 ? &depth : (int *)0);
  printf("%d\n", depth);
  return 0;
}
