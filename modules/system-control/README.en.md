[简体中文](README.md) | **English**

# System Control Module

Scripts for macOS display sleep, keep-awake behavior and built-in display backlight. See the [main README](../../README.en.md) for gateway configuration.

## Usage

Run the relevant command from this directory. These commands actually change display or keep-awake state:

```bash
./build-backlight-helper.command
./backlight-off-keep-awake.command
./backlight-restore.command
./keep-awake-display-off.command
./stop-keep-awake.command
```

Choose the command for the intended action; do not run all commands sequentially as an installation procedure.

## Requirements and constraints

Xcode Command Line Tools are required to compile the helper. `brightness` is an optional debugging/fallback tool.

`backlight-off-keep-awake.command` uses a C helper built from this module's `src/codexremotecontact-backlight.c`. It targets online built-in displays and skips external monitors.
