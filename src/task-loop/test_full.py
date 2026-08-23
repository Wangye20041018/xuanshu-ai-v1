import sys, os
sys.path.insert(0, 'src/task-loop')
from engine import TaskLoop

# Test syntax fix via real execution
script = 'print（"hello"）\nprint("done")'
loop = TaskLoop("test", work_dir=".", max_iterations=3, timeout=10)
result = loop.run(script)

print("success:", result.success)
print("iterations:", result.total_iterations)
print("final_state:", result.final_state)
for log in result.logs:
    print(f"  [{log.index}] {log.state.name} | exit={log.exit_code} | fix={log.fix_applied}")
if result.error:
    print("error:", result.error[:200])
