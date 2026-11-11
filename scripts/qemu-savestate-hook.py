#!/usr/bin/env python3
"""Expose QEMU's existing synchronous snapshot writer for the GNW machine."""
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
source = root / 'migration/savevm.c'
text = source.read_text().replace('static int qemu_savevm_state(QEMUFile *f, Error **errp)',
                                  'int qemu_savevm_state(QEMUFile *f, Error **errp)')
if text != source.read_text():
    source.write_text(text)
header = root / 'migration/savevm.h'
text = header.read_text()
prototype = 'int qemu_savevm_state(QEMUFile *f, Error **errp);\n'
if prototype not in text:
    header.write_text(text.replace('bool qemu_savevm_state_blocked', prototype + 'bool qemu_savevm_state_blocked'))
