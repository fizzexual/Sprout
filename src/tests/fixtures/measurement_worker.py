"""Ordinary small owned process fixtures; never launch Sprout or a benchmark."""
import json
import os
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else 'normal'

def emit(fd, data):
    while data:
        count = os.write(fd, data)
        if count <= 0: raise OSError('ordinary fixture short write')
        data = data[count:]

if mode == 'exit': raise SystemExit(3)
if mode == 'wrong': emit(1, b'NOT_READY\n'); time.sleep(2); raise SystemExit(0)
if mode == 'partial': emit(1, b'READY'); raise SystemExit(0)
if mode == 'overflow': emit(1, b'x' * 8192 + b'\n'); time.sleep(2); raise SystemExit(0)
emit(1, b'READY\n')
if sys.stdin.buffer.readline() != b'GO\n': raise SystemExit(91)
if mode == 'wait': time.sleep(2)
if mode == 'stderr': emit(2, b'ordinary controlled diagnostic')
emit(1, b'DONE\n')
if sys.stdin.buffer.readline() != b'ACK\n': raise SystemExit(92)
emit(1, json.dumps({'result': {'ok': True}, 'unchanged': True}).encode() + b'\n')
if mode == 'delayed-exit': time.sleep(.05)
