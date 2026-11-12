/* Test-process-only observer. Never writes PCM or queries HAL in an IOProc. */
#include <CoreAudio/CoreAudio.h>
#include <mach/mach_time.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CAPACITY (96u * 1024u * 1024u)
#define VOICES 32
typedef struct {
    AudioDeviceIOProc original;
    void *client;
    AudioDeviceIOProcID proc;
    AudioDeviceID device;
    AudioStreamBasicDescription format;
    uint32_t id;
} Context;
typedef struct __attribute__((packed)) {
    uint64_t host_ns;
    double rate;
    uint32_t voice, channels, flags, bytes;
    int32_t status;
    uint32_t buffers;
} Record;
typedef struct {
    char magic[4];
    uint32_t version, header_bytes, used, contexts, registered, destroyed;
    uint32_t overflow, failed, starts, stops, records;
} Header;
_Static_assert(sizeof(Header) == 48 && sizeof(Record) == 40, "trace ABI");
static Context contexts[VOICES];
static unsigned char *storage;
static uint32_t capacity = CAPACITY;
static const char *output_path;
static mach_timebase_info_data_t timebase;
static _Atomic uint32_t used, context_count, registered, destroyed;
static _Atomic uint32_t overflow, failed, starts, stops, records;

static OSStatus get_property(AudioObjectID id, AudioObjectPropertySelector selector,
                             void *value, UInt32 size) {
    AudioObjectPropertyAddress address = {selector, kAudioObjectPropertyScopeOutput,
                                         kAudioObjectPropertyElementMain};
    return AudioObjectGetPropertyData(id, &address, 0, NULL, &size, value);
}

static OSStatus observed_callback(AudioDeviceID device, const AudioTimeStamp *now,
    const AudioBufferList *input, const AudioTimeStamp *input_time,
    AudioBufferList *out, const AudioTimeStamp *out_time, void *opaque) {
    Context *c = opaque;
    OSStatus status = c->original(device, now, input, input_time, out, out_time, c->client);
    if (!storage) return status;
    uint64_t ticks = mach_absolute_time();
    Record r = {.host_ns = (uint64_t)((__uint128_t)ticks * timebase.numer / timebase.denom),
                .rate = c->format.mSampleRate, .voice = c->id,
                .flags = c->format.mFormatFlags, .status = status,
                .buffers = out ? out->mNumberBuffers : 0};
    if (out && out->mNumberBuffers) {
        r.channels = out->mBuffers[0].mNumberChannels;
        r.bytes = out->mBuffers[0].mData ? out->mBuffers[0].mDataByteSize : 0;
    }
    uint32_t offset = atomic_load(&used);
    for (;;) {
        if (r.bytes > capacity - sizeof(r) || offset > capacity - sizeof(r) - r.bytes) {
            atomic_fetch_add(&overflow, 1);
            return status;
        }
        if (atomic_compare_exchange_weak(&used, &offset, offset + sizeof(r) + r.bytes)) break;
    }
    memcpy(storage + offset, &r, sizeof(r));
    if (r.bytes) memcpy(storage + offset + sizeof(r), out->mBuffers[0].mData, r.bytes);
    atomic_fetch_add(&records, 1);
    return status;
}

static OSStatus observed_create(AudioDeviceID device, AudioDeviceIOProc original,
                                void *client, AudioDeviceIOProcID *proc) {
    if (!storage) return AudioDeviceCreateIOProcID(device, original, client, proc);
    uint32_t index = atomic_fetch_add(&context_count, 1);
    if (index >= VOICES) {
        atomic_fetch_add(&overflow, 1);
        return AudioDeviceCreateIOProcID(device, original, client, proc);
    }
    Context *c = &contexts[index];
    c->original = original; c->client = client; c->device = device; c->id = index;
    OSStatus query = get_property(device, kAudioDevicePropertyStreamFormat,
                                  &c->format, sizeof(c->format));
    if (query != noErr) atomic_fetch_add(&failed, 1);
    OSStatus status = AudioDeviceCreateIOProcID(device, observed_callback, c, proc);
    if (status == noErr && *proc) {
        c->proc = *proc;
        atomic_fetch_add(&registered, 1);
    } else atomic_fetch_add(&failed, 1);
    return status;
}

static OSStatus observed_destroy(AudioDeviceID device, AudioDeviceIOProcID proc) {
    OSStatus status = AudioDeviceDestroyIOProcID(device, proc);
    for (uint32_t i = 0; i < VOICES; i++) {
        if (contexts[i].proc == proc && contexts[i].device == device && proc) {
            if (status == noErr) atomic_fetch_add(&destroyed, 1);
            else atomic_fetch_add(&failed, 1);
            break;
        }
    }
    return status;
}
static OSStatus observed_start(AudioDeviceID device, AudioDeviceIOProcID proc) {
    atomic_fetch_add(&starts, 1);
    return AudioDeviceStart(device, proc);
}
static OSStatus observed_stop(AudioDeviceID device, AudioDeviceIOProcID proc) {
    atomic_fetch_add(&stops, 1);
    return AudioDeviceStop(device, proc);
}
static const struct { const void *replacement, *original; } interposes[]
    __attribute__((used, section("__DATA,__interpose"))) = {
    {(const void *)observed_create, (const void *)AudioDeviceCreateIOProcID},
    {(const void *)observed_destroy, (const void *)AudioDeviceDestroyIOProcID},
    {(const void *)observed_start, (const void *)AudioDeviceStart},
    {(const void *)observed_stop, (const void *)AudioDeviceStop},
};

__attribute__((constructor)) static void initialize(void) {
    output_path = getenv("COREAUDIO_PROBE_OUTPUT");
    if (!output_path) return;
    if (!atomic_is_lock_free(&used)) abort();
    mach_timebase_info(&timebase);
    storage = malloc(capacity);
    if (!storage) abort();
    /* Fault in pages on this ordinary thread, before any realtime callback. */
    for (uint32_t i = 0; i < capacity; i += 4096) ((volatile unsigned char *)storage)[i] = 0;
}
__attribute__((destructor)) static void finish(void) {
    if (!storage || !output_path) return;
    Header h = {.magic = {'G','C','A','1'}, .version = 1, .header_bytes = sizeof(h),
        .used = atomic_load(&used), .contexts = atomic_load(&context_count),
        .registered = atomic_load(&registered), .destroyed = atomic_load(&destroyed),
        .overflow = atomic_load(&overflow), .failed = atomic_load(&failed),
        .starts = atomic_load(&starts), .stops = atomic_load(&stops),
        .records = atomic_load(&records)};
    /* QEMU must destroy every observed IOProc before output is accepted.
     * Retain storage/contexts until process exit; do not race with HAL by freeing. */
    if (h.registered != h.destroyed) { h.failed++; h.used = 0; }
    FILE *file = fopen(output_path, "wb");
    if (!file) return;
    if (fwrite(&h, sizeof(h), 1, file) != 1 || fwrite(storage, h.used, 1, file) != 1)
        fprintf(stderr, "coreaudio probe: incomplete write\n");
    fclose(file);
}

#ifdef PROBE_TOOL
int main(void) {
    AudioDeviceID id = 0;
    UInt32 size = sizeof(id);
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    OSStatus result = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address,
                                                0, NULL, &size, &id);
    AudioStreamBasicDescription format = {0};
    UInt32 frames = 0, running = 0, running_somewhere = 0;
    AudioValueRange range = {0};
    if (!result && id) result = get_property(id, kAudioDevicePropertyStreamFormat, &format, sizeof(format));
    if (!result) result = get_property(id, kAudioDevicePropertyBufferFrameSize, &frames, sizeof(frames));
    if (!result) result = get_property(id, kAudioDevicePropertyBufferFrameSizeRange, &range, sizeof(range));
    if (!result) result = get_property(id, kAudioDevicePropertyDeviceIsRunning, &running, sizeof(running));
    if (!result) result = get_property(id, kAudioDevicePropertyDeviceIsRunningSomewhere,
                                      &running_somewhere, sizeof(running_somewhere));
    printf("{\"status\":%d,\"device\":%u,\"rate\":%.0f,\"channels\":%u,"
           "\"flags\":%u,\"bits\":%u,\"frames\":%u,\"minFrames\":%.0f,"
           "\"maxFrames\":%.0f,\"running\":%u,\"runningSomewhere\":%u}\n", result, id, format.mSampleRate,
           format.mChannelsPerFrame, format.mFormatFlags, format.mBitsPerChannel,
           frames, range.mMinimum, range.mMaximum, running, running_somewhere);
    return result || !id;
}
#endif

#ifdef PROBE_SELFTEST
static OSStatus fake_callback(AudioDeviceID d, const AudioTimeStamp *n,
    const AudioBufferList *in, const AudioTimeStamp *it, AudioBufferList *out,
    const AudioTimeStamp *ot, void *client) {
    (void)d; (void)n; (void)in; (void)it; (void)ot;
    (*(int *)client)++;
    float *pcm = out->mBuffers[0].mData;
    for (int i = 0; i < 32; i++) pcm[i] = (float)i / 64;
    return 17;
}
int main(int argc, char **argv) {
    (void)argv;
    int calls = 0;
    float pcm[32];
    AudioBufferList out = {.mNumberBuffers = 1,
        .mBuffers = {{.mNumberChannels = 2, .mDataByteSize = sizeof(pcm), .mData = pcm}}};
    Context c = {.original = fake_callback, .client = &calls, .id = 0,
                 .format = {.mSampleRate = 44100, .mFormatFlags = kAudioFormatFlagIsFloat}};
    if (argc > 1) capacity = 200; /* second call must overflow without changing native output */
    for (int j = 0; j < 2; j++) {
        if (observed_callback(0, NULL, NULL, NULL, &out, NULL, &c) != 17 || calls != j + 1) return 1;
        for (int i = 0; i < 32; i++) if (pcm[i] != (float)i / 64) return 2;
    }
    return (argc > 1 && atomic_load(&overflow) != 1) ? 3 : 0;
}
#endif
