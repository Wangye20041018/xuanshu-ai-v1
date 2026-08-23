import sys, os, json

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTPUT_DIR = os.path.join(PROJECT_ROOT, 'output')
TEMP_DIR = os.path.join(PROJECT_ROOT, 'temp')

os.chdir(PROJECT_ROOT)
sys.path.insert(0, 'src/task-loop')
from engine import TaskLoop

# Test: syntax error auto-fix with file output
script = f'''path = r"{os.path.join(OUTPUT_DIR, 'report_test.txt')}"
import os
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", encoding="utf-8") as f：
    f。write("Task Loop 自动修复通过！")
print("DONE", path)
'''

loop = TaskLoop(
    "创建测试报告",
    work_dir=PROJECT_ROOT,
    max_iterations=3,
    timeout=10,
    success_markers=["DONE"],
)

result = loop.run(script)

# Write result to a file
result_file = os.path.join(TEMP_DIR, "engine_result.json")
os.makedirs(os.path.dirname(result_file), exist_ok=True)
with open(result_file, "w", encoding="utf-8") as f:
    json.dump(result.to_dict(), f, ensure_ascii=False, indent=2)

print(f"Result written to {result_file}")
print(f"Success: {result.success}")
print(f"Iterations: {result.total_iterations}")
print(f"State: {result.final_state.name}")
print(f"Output: {result.output.strip()}")
if result.error:
    print(f"Error: {result.error[:500]}")
