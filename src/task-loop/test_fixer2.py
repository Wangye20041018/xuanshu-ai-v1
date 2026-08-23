import sys
sys.path.insert(0, 'src/task-loop')
from engine import AutoFixer

# Test 1: stderr with File line info
stderr1 = '  File "<string>", line 1\n    print（"hello"）\nSyntaxError: invalid character'
script1 = 'print（"hello"）\nprint("done")'
fix1 = AutoFixer.attempt_fix(stderr1, script1)
print("Fix1:", repr(fix1)[:100])

# Test 2: stderr with SyntaxError line
stderr2 = 'SyntaxError: invalid syntax at line 2'
script2 = 'print（"hello"）\nprint（"world"）'
fix2 = AutoFixer.attempt_fix(stderr2, script2)
print("Fix2:", repr(fix2)[:100])

# Test 3: no line info at all
stderr3 = 'SyntaxError: invalid syntax'
script3 = 'x = 1\nprint（"ok"）'
fix3 = AutoFixer.attempt_fix(stderr3, script3)
print("Fix3:", repr(fix3)[:100])
