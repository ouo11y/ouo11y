#ifndef OUO_VITALS_CORE_H
#define OUO_VITALS_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

/// Process start time in epoch milliseconds (`sysctl` KERN_PROC_PID `kp_proc.p_starttime`), or a
/// negative value when the kernel did not answer.
double ouo_vitals_process_start_ms(void);

/// Wall-clock time (epoch ms) at which this image was loaded: a constructor that runs before
/// `main`, the equivalent of Sentry's "module initialization" timestamp. Used as the start of a
/// prewarmed launch, where the process start is when iOS prewarmed the app, not when the user tapped it.
double ouo_vitals_load_time_ms(void);

#ifdef __cplusplus
}
#endif

#endif
