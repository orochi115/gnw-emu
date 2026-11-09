gnw_libs = [dependency('libjpeg')]
arm_common_ss.add(when: 'CONFIG_GNW', if_true: [files(
  'gnw.c',
  'gnw_display.c',
  'gnw_session_lock.c',
  'gnw_regs.c',
  'gnw_gpio.c',
  'gnw_ospi.c',
  'gnw_ltdc.c',
  'gnw_dma.c',
  'gnw_timer.c',
  'gnw_cryp.c',
  'gnw_jpeg.c',
  'gnw_adc.c',
  'gnw_dac.c',
  'gnw_spi.c',
  'gnw_sdcard.c',
  'gnw_flash.c',
), gnw_libs])
