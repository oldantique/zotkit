#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
native_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_file="$native_dir/src/zoterochat_helper.c"
build_dir="$native_dir/build/universal"
dist_dir="$native_dir/dist"
sdk_path=$(xcrun --sdk macosx --show-sdk-path)

mkdir -p "$build_dir" "$dist_dir"

common_flags="-isysroot $sdk_path -mmacosx-version-min=12.0 -O2 -std=c17 -Wall -Wextra -Wpedantic -Werror"

xcrun clang $common_flags -arch arm64 "$source_file" -o "$build_dir/zoterochat-helper-arm64"
xcrun clang $common_flags -arch x86_64 "$source_file" -o "$build_dir/zoterochat-helper-x86_64"
xcrun lipo -create \
  "$build_dir/zoterochat-helper-arm64" \
  "$build_dir/zoterochat-helper-x86_64" \
  -output "$dist_dir/zoterochat-helper"
chmod 0755 "$dist_dir/zoterochat-helper"
codesign --force --sign - "$dist_dir/zoterochat-helper"

echo "Built $dist_dir/zoterochat-helper"
xcrun lipo -info "$dist_dir/zoterochat-helper"
