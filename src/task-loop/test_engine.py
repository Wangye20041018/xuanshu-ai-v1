import sys
sys.path.insert(0, 'src/task-loop')
from engine import TaskLoop

# Test 1: Simple success
loop = TaskLoop("测试：计算 1+1", work_dir=".", max_iterations=1)
result = loop.run("print(1+1)")
print("Test 1 (success):", result.success, "| iters:", result.total_iterations)

# Test 2: Auto-fix import
loop2 = TaskLoop("测试：自动修复导入", work_dir=".", max_iterations=3, timeout=15)
result2 = loop.run("from Crypto.Cipher import AES\nprint('ok')")
print("Test 2 (auto-fix):", result2.success, "| iters:", result2.total_iterations)
for log in result2.logs:
    print(f"  [{log.index}] {log.state.name} | err: {log.error_type} | fix: {log.fix_applied}")

print("\nAll tests done")
