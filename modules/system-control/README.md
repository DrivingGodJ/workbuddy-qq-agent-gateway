# System Control Module / 系统控制模块

Scripts in this folder manage display sleep, keep-awake, and built-in display backlight.

这个目录里的脚本用于管理显示器休眠、防休眠和内置屏背光。

Useful commands / 常用命令：

```bash
./build-backlight-helper.command
./backlight-off-keep-awake.command
./backlight-restore.command
./keep-awake-display-off.command
./stop-keep-awake.command
```

`backlight-off-keep-awake.command` uses a small C helper compiled from `src/workbuddy-qq-backlight.c`. The helper only targets online built-in displays and skips external displays.

`backlight-off-keep-awake.command` 使用由 `src/workbuddy-qq-backlight.c` 编译出来的小型 C helper。它只处理在线的内置显示器，并跳过外接显示器。

Requirements / 依赖：

- Xcode Command Line Tools for compiling the helper.
- Xcode Command Line Tools：用于编译 helper。
- `brightness` is optional but useful for debugging and fallback workflows.
- `brightness` 可选，适用于电脑GUI控制。
