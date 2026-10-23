#include "OuoVitalsCore.h"

#include <sys/sysctl.h>
#include <sys/time.h>
#include <unistd.h>

static double load_time_ms = -1;

static double timeval_ms(struct timeval tv) {
    return (double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0;
}

__attribute__((constructor)) static void ouo_vitals_record_load_time(void) {
    struct timeval now;
    if (gettimeofday(&now, NULL) == 0) load_time_ms = timeval_ms(now);
}

double ouo_vitals_process_start_ms(void) {
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
    struct kinfo_proc info;
    size_t size = sizeof(info);
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) return -1;
    return timeval_ms(info.kp_proc.p_starttime);
}

double ouo_vitals_load_time_ms(void) {
    return load_time_ms;
}
