#!/bin/sh
# 部署脚本示例（.sh：编辑器里有 shell 高亮）
set -e
TARGET=/opt/app
echo "deploying to $TARGET"
for f in *.tar.gz; do
  echo "unpack $f"
done
