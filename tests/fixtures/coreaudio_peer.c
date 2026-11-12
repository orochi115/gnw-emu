/* Test-owned silent output client. No device setters or input/mix capture. */
#include <CoreAudio/CoreAudio.h>
#include <mach/mach_time.h>
#include <stdatomic.h>
#include <signal.h>
#include <poll.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static _Atomic uint64_t callbacks;
static volatile sig_atomic_t exiting;
static void on_signal(int number) { (void)number; exiting = 1; }
static OSStatus silence(AudioDeviceID device, const AudioTimeStamp *now,
    const AudioBufferList *input, const AudioTimeStamp *input_time,
    AudioBufferList *output, const AudioTimeStamp *output_time, void *client) {
    (void)device; (void)now; (void)input; (void)input_time; (void)output_time; (void)client;
    for (UInt32 i = 0; i < output->mNumberBuffers; i++) {
        AudioBuffer *b = &output->mBuffers[i];
        if (b->mData) memset(b->mData, 0, b->mDataByteSize);
    }
    atomic_fetch_add(&callbacks, 1);
    return noErr;
}
static void stats(const char *event, AudioDeviceID device) {
    UInt32 running = 0, size = sizeof(running);
    AudioObjectPropertyAddress address = {kAudioDevicePropertyDeviceIsRunning,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    OSStatus status = AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &running);
    printf("{\"event\":\"%s\",\"pid\":%d,\"device\":%u,\"callbacks\":%llu,"
           "\"runningStatus\":%d,\"running\":%u}\n",
           event, getpid(), device, (unsigned long long)atomic_load(&callbacks), status, running);
    fflush(stdout);
}
int main(void) {
    if (!atomic_is_lock_free(&callbacks)) return 2;
    struct sigaction action = {.sa_handler = on_signal};
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
    AudioDeviceID device = 0;
    AudioDeviceIOProcID proc = NULL;
    UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address,
                                                0, NULL, &size, &device);
    if (status || !device) { fprintf(stderr, "peer device query failed: %d\n", status); return 3; }
    status = AudioDeviceCreateIOProcID(device, silence, NULL, &proc);
    if (status || !proc) { fprintf(stderr, "peer registration failed: %d\n", status); return 4; }
    status = AudioDeviceStart(device, proc);
    if (status) {
        AudioDeviceDestroyIOProcID(device, proc);
        fprintf(stderr, "peer start failed: %d\n", status); return 5;
    }
    stats("ready", device);
    mach_timebase_info_data_t scale; mach_timebase_info(&scale);
    uint64_t start = mach_absolute_time();
    char command[64]; size_t used = 0;
    while (!exiting) {
        if ((__uint128_t)(mach_absolute_time() - start) * scale.numer / scale.denom > 60000000000ULL) break;
        struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
        int result = poll(&input, 1, 100);
        if (result < 0) continue; /* signal interruption; recheck exit/deadline */
        if (!result) continue;
        char bytes[64]; ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (count <= 0) break;
        for (ssize_t i = 0; i < count; i++) {
            if (bytes[i] == '\n') {
                command[used] = 0;
                if (!strcmp(command, "stats")) stats("stats", device);
                else if (!strcmp(command, "quit")) exiting = 1;
                else { fprintf(stderr, "peer invalid command\n"); exiting = 1; }
                used = 0;
            } else if (used + 1 < sizeof(command)) command[used++] = bytes[i];
            else { fprintf(stderr, "peer oversized command\n"); exiting = 1; break; }
        }
    }
    OSStatus stopped = AudioDeviceStop(device, proc);
    OSStatus destroyed = AudioDeviceDestroyIOProcID(device, proc);
    printf("{\"event\":\"closed\",\"stopStatus\":%d,\"destroyStatus\":%d,\"callbacks\":%llu}\n",
           stopped, destroyed, (unsigned long long)atomic_load(&callbacks));
    fflush(stdout);
    return stopped || destroyed;
}
