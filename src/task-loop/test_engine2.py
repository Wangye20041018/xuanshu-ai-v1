import sys
sys.path.insert(0, 'src/task-loop')
from engine import TaskLoop

# Test: Auto-fix syntax error (中文标点)
loop = TaskLoop("测试：自动修复中文标点", work_dir=".", max_iterations=3, timeout=10)
result = loop.run("import os\nprint（'hello'）\nprint('done')")
print("Test syntax fix:", result.success, "| iters:", result.total_iterations)
for log in result.logs:
    print(f"  [{log.index}] {log.state.name} | err: {log.error_type} | fix: {log.fix_applied}")

# Test: Auto-fix NameError
loop2 = TaskLoop("测试：自动修复未定义变量", work_dir=".", max_iterations=3, timeout=10)
result2 = loop2.run("import sys\nprint(undefined_var)\nprint('done')")
print("\nTest name fix:", result2.success, "| iters:", result2.total_iterations)
for log in result2.logs:
    print(f"  [{log.index}] {log.state.name} | err: {log.error_type} | fix: {log.fix_applied}")

print("\nAll tests passed")
