import sys, os, json
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTPUT_DIR = os.path.join(PROJECT_ROOT, 'output')

sys.path.insert(0, os.path.join('src', 'task-loop'))
from runner import run_with_llm_fallback

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Test 1: 脚本有中文标点 → 自动修复成功
script1 = f'''import os
path = r"{os.path.join(OUTPUT_DIR, 'report1.txt')}"
with open(path, "w", encoding="utf-8") as f：
    f。write("Task Loop 自动修复通过")
print("OK", path)
'''

result1 = run_with_llm_fallback(
    goal="创建 report1.txt",
    work_dir=PROJECT_ROOT,
    initial_script=script1,
    max_iterations=3,
    timeout=10,
)
print("=== Test 1 (auto-fix) ===")
print(json.dumps(result1, ensure_ascii=False, indent=2))

# Test 2: 正常脚本 → 直接成功
script2 = f'''import os
path = r"{os.path.join(OUTPUT_DIR, 'report2.txt')}"
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    f.write("Task Loop 直接成功")
print("DONE", path)
'''

result2 = run_with_llm_fallback(
    goal="创建 report2.txt",
    work_dir=PROJECT_ROOT,
    initial_script=script2,
    max_iterations=3,
    timeout=10,
    success_markers=["DONE"],
)
print("\n=== Test 2 (direct success) ===")
print(json.dumps(result2, ensure_ascii=False, indent=2))

# Test 3: 脚本有不可修复的错误 → need_fix
script3 = '''import nonexistent_module_xyz
print("hello")
'''

result3 = run_with_llm_fallback(
    goal="测试不可修复错误",
    work_dir=PROJECT_ROOT,
    initial_script=script3,
    max_iterations=2,
    timeout=10,
)
print("\n=== Test 3 (need_fix) ===")
print(json.dumps(result3, ensure_ascii=False, indent=2))
