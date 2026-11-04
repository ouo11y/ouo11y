# Demo-only: libouochaos.so, the deliberate NDK crashes of the Chaos module (ouo_chaos_crash.c).
cmake_minimum_required(VERSION 3.22.1)
project(ouochaos C)

add_library(ouochaos SHARED ouo_chaos_crash.c)
# A GNU build id, as every NDK release build has: the tombstone and ouo's report carry it.
target_link_options(ouochaos PRIVATE "-Wl,--build-id=sha1")
