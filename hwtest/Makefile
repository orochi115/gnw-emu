# Cortex-M7 timing bench.  `make` builds both images:
#   build/bench_ram.bin    load at 0x00000000 (ITCM) through the debugger
#   build/bench_bank2.bin  program at 0x08138000 (bank 2 tail, after Retro-Go)
PREFIX ?= $(if $(wildcard /opt/homebrew/bin/arm-none-eabi-gcc),/opt/homebrew/bin/,/opt/gcc-arm-none-eabi-10.3-2021.10/bin/)arm-none-eabi-
CC      = $(PREFIX)gcc
OBJCOPY = $(PREFIX)objcopy
SIZE    = $(PREFIX)size
CFLAGS  = -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard -O2 -g \
          -ffreestanding -fno-builtin -nostdlib -Wall -Wextra -Ibuild -I.
LDFLAGS = -nostdlib -Wl,--gc-sections -Wl,-Map=$(basename $@).map

all: build/bench_ram.bin build/bench_bank2.bin

build/kernels.S build/kernels.h: gen_kernels.py
	@mkdir -p build
	python3 gen_kernels.py build/kernels.S build/kernels.h

SRCS = startup.S bench.c build/kernels.S
DEPS = $(SRCS) bench.h tests.def snap.def build/kernels.h common.ld

build/bench_ram.elf: $(DEPS) link_ram.ld
	$(CC) $(CFLAGS) $(LDFLAGS) -T link_ram.ld -o $@ $(SRCS)
	$(SIZE) $@

build/bench_bank2.elf: $(DEPS) link_bank2.ld
	$(CC) $(CFLAGS) -DBENCH_BANK2 $(LDFLAGS) -T link_bank2.ld -o $@ $(SRCS)
	$(SIZE) $@

%.bin: %.elf
	$(OBJCOPY) -O binary -j .text $< $@

clean:
	rm -rf build

.PHONY: all clean
