import sys, os
sys.path.insert(0, 'src/task-loop')
from engine import TaskLoop

# Minimal test - no file I/O
script = 'print("hello world")\nprint("SUCCESS")'
loop = TaskLoop("minimal test", work_dir=".", max_iterations=2, timeout=5)
result = loop.run(script)
print("SUCCESS:", result.success)
print("ITERATIONS:", result.total_iterations)
print("STATE:", result.final_state)
print("OUTPUT:", result.output[:200])
