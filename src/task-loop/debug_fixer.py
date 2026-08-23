import sys
sys.path.insert(0, 'src/task-loop')
from engine import AutoFixer
import traceback

try:
    script = 'print（"hello"）'
    print("Input script:", repr(script))
    result = AutoFixer.attempt_fix('SyntaxError: invalid syntax', script)
    print("Fix result:", result)
except Exception as e:
    traceback.print_exc()
