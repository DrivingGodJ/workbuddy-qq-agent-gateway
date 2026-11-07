**简体中文** | [English](README.en.md)

# 系统控制模块

用于 macOS 显示器休眠、防休眠和内置屏背光的脚本。通用网关配置见[项目首页](../../README.md)。

## 使用方式

在本目录运行所需命令；这些命令会实际改变显示或防休眠状态：

```bash
./build-backlight-helper.command
./backlight-off-keep-awake.command
./backlight-restore.command
./keep-awake-display-off.command
./stop-keep-awake.command
```

按操作目的选择单条命令，不要将全部命令作为安装流程连续执行。

## 依赖与约束

编译辅助程序需要 Xcode Command Line Tools。`brightness` 为可选的调试与后备工具。

`backlight-off-keep-awake.command` 使用由本模块 `src/codexremotecontact-backlight.c` 编译的 C 辅助程序，仅处理在线内置屏，跳过外接显示器。
