/* Result table shared by bench.c, the OpenOCD scripts and parse.py. */
#ifndef BENCH_H
#define BENCH_H

#define RES_ADDR        0x2001E000u     /* last 8 KiB of DTCM */
#define RES_SIZE        0x2000u
#define STACK_TOP       0x2001E000u
#define RES_MAGIC       0x424E5747u     /* "GWNB" */
#define RES_VERSION     1u

#define ST_RUNNING      0x52554E21u     /* "!NUR" */
#define ST_DONE         0x454E4F44u     /* "DONE" */
#define ST_FAULT        0x544C5546u     /* "FULT" */

#define BUILD_RAM       0u
#define BUILD_BANK2     1u

/* Regions (entry.region) */
#define R_NONE   0      /* peripheral tests */
#define R_CODE   1      /* where the bench itself runs (ITCM or bank 2) */
#define R_ITCM   2
#define R_DTCM   3
#define R_AXI    4
#define R_AHB    5
#define R_SRD    6
#define R_FLASH1 7
#define R_FLASH2 8
#define R_OSPI   9

/* Cache configurations (entry.cfg) */
#define CFG_OFF  0      /* I-cache off, D-cache off */
#define CFG_ON   1      /* I-cache on, D-cache on   */

#ifndef __ASSEMBLER__
#include <stdint.h>

struct entry {
    uint16_t test;
    uint8_t  region;
    uint8_t  cfg;
    uint32_t iters;     /* loop iterations, or a test-specific parameter */
    uint32_t ops;       /* operations per measurement (see tests.def unit) */
    uint32_t cmin;      /* fastest of the measured runs, in DWT cycles */
    uint32_t cmax;      /* slowest */
};

#define NSNAP 104
#define NMPU  8

struct header {
    uint32_t magic, version, status, progress;
    uint32_t nentries, build, flags, nsnap;
    uint32_t fault[12];     /* CFSR HFSR MMFAR BFAR IPSR r0 r1 r2 r3 r12 lr pc */
    uint32_t mpu[NMPU][2];  /* RBAR, RASR as found */
    uint32_t snap[NSNAP];   /* values in snap.def order */
    struct entry e[];
};

#define MAX_ENTRIES ((RES_SIZE - sizeof(struct header)) / sizeof(struct entry))
#endif
#endif
