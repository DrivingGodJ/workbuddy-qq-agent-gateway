[简体中文](README.md) | **English**

# WorkBuddy QQ Agent Gateway

Connect a local WorkBuddy Agent to QQ, maintain group/private conversations, and use a web console for live output, permissions, notification subscriptions and stickers.

[Offline demo](#quick-start) · [Detailed features and deployment](docs/readme-reference.zh-CN.md) · [Security](SECURITY.md)

![Group chat and live output using synthetic demo data](docs/screenshots/conversation.png)

This project is designed around WorkBuddy; Codex support is a compatibility path. It extends [Epic0522/Codex-Remote-Contact](https://github.com/Epic0522/Codex-Remote-Contact) and is independently published as a sanitized snapshot with fresh history. Upstream has no declared license, so public source availability is not a complete open-source grant.

## Features

- **Persistent conversations** are isolated by default; explicit private/group links share model context and use a serial queue.
- **Controlled QQ tools** read/send messages, quotes, images, files and native stickers with current identity, target and permission checks.
- **Live console** shows output, queues and diagnostics, controls model/reasoning/compression/access settings and supports immediate cancellation.
- **Notification subscriptions** summarize read-only sources per destination and release source messages only after all subscribers succeed.
- **Optional integrations** include Home Assistant, Apple Calendar/Reminders, XiaoAI announcements and Qzone automation, each with separate authorization boundaries.

## Quick start

Try the local demo without QQ or model access. Requires Node.js **20.6+**:

```bash
git clone https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway.git
cd workbuddy-qq-agent-gateway
npm run demo
```

Open `http://127.0.0.1:3790/client.html`. It uses the real frontend and synthetic state, rejects mutation requests and never reads a real gateway, Keychain or messages. README screenshots also use demo data.

Live deployment requires **macOS, Python 3.10+**, an authenticated WorkBuddy / CodeBuddy CLI and a separately installed/authenticated SnowLuma or compatible OneBot bridge. Model use consumes your own allowance. Generic OneBot bridges may lack extension APIs. Container file sending/recovery also needs Docker, Colima and an existing SnowLuma container.

```bash
bash modules/workbuddy-agent/setup.sh
cp config/qq-only.env.example config/qq-only.env
mkdir -p runtime/qq-only-data
cp config/settings.example.json runtime/qq-only-data/settings.json
```

Then follow the detailed deployment reference to configure distinct owner/bot QQ IDs, tokens, callbacks and allowlists before starting. The Node service has no production npm dependencies; Python SDK versions are pinned in [requirements.txt](modules/workbuddy-agent/requirements.txt). Do not expose an unprotected console to the internet.

## Usage

Add allowed groups or private contacts in the console and configure each session. In Agent mode, read-only, workspace write and full access are different execution permissions. Full access can let trusted members operate the whole computer through the Agent. Calendar/Reminder writes and Qzone automation default to off; Qzone publishing is restricted to OWNER authorization.

Linking a private chat to a group shares model memory and workspace, so private content may influence later group answers. Unlinking does not erase content already in the group thread. Use only among mutually trusted channels. Reading linked messages does not inherit another channel's permissions.

Source groups, websites, image text, quotes and forwards cannot change permissions or destinations. Private environments, runtime state, messages, session mappings, real identities and login data stay out of the repository. See the [context/permissions reference (Chinese)](docs/readme-reference.zh-CN.md) and [local customization guide](docs/LOCAL_CUSTOMIZATION.md).

## Development and checks

```bash
npm test
bash modules/workbuddy-agent/setup.sh
modules/workbuddy-agent/.venv/bin/python test/workbuddy-bridge-recovery.test.py
modules/workbuddy-agent/.venv/bin/python test/workbuddy-image-preview.test.py
npm run audit:public
```

Tests use synthetic identities and temporary directories without real QQ or publication. Linux CI covers portable logic only, not full Linux deployment. Verify real QQ, Apple applications and CLI integrations in your own macOS environment.

Ordinary replies time out after 3 continuous minutes without progress; compression has a separate absolute 6-minute limit. One recovery is allowed only with confirmed cleanup, available auditing and no potential side effects. Sending, writing files, home control or uncertain outcomes prevent automatic replay. QQ API changes, risk controls and uploads depend on the bridge. Unavailable Qzone APIs are not fabricated, and sent content cannot be guaranteed retractable.

## Documentation and support

- [Detailed features, setup, permissions and limits (Chinese)](docs/readme-reference.zh-CN.md)
- [Home Assistant](docs/HOME_ASSISTANT.md) · [Local customization](docs/LOCAL_CUSTOMIZATION.md)
- [Provenance](docs/PROVENANCE.md) · [License notice](LICENSE-NOTICE.md)
- [Report an issue](https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway/issues)

## License and credits

Thanks to original author [Epic0522](https://github.com/Epic0522). Upstream has no license, and this repository does not claim a blanket MIT/Apache license. Read the license/provenance notices and obtain necessary permissions before use or distribution. Dependencies and persona materials have their own terms.
