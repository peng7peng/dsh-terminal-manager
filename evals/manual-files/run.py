# 巡检脚本示例（.py：编辑器里有 Python 高亮）
import json

def check(host: str, port: int) -> bool:
    """返回设备是否在线（示例，不真的连）"""
    return port > 0

if __name__ == "__main__":
    print(json.dumps({"host": "10.0.0.5", "ok": check("10.0.0.5", 22)}))
