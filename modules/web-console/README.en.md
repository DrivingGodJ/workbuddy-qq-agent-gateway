[简体中文](README.md) | **English**

# Web Console Module

The Hub web console, with the same frontend reused by the macOS client. See the [main README](../../README.en.md) for gateway setup.

## Usage

After starting Hub, open `http://localhost:3789`. Add Agent groups from groups already joined by the bot that are not read-only notification sources. Add Agent private chats by QQ ID. Changes immediately persist in the local private `settings.json` and survive refreshes and restarts.

## Development and maintenance

`client.html`, `client.css` and `client.js` in this module's `public/` directory are the only editable frontend sources. Client builds copy them one way into the app bundle; do not maintain a second source copy inside the Mac client's Resources.

Hub's static assets also include `modules/web-console/public/`; paths are relative to the repository root. Never commit real allowlists or runtime configuration.
