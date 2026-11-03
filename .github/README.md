<div align="center">

# CMCP

### Let Claude on your cloud PC use this computer's files, commands and desktop

**Manage every cloud PC from one card-based desktop app, with independent connections, automatic recovery and easy sign-in.**

[![Version](https://img.shields.io/github/v/release/isAlexYoung/cmcp?color=blue&label=version)](https://github.com/isAlexYoung/cmcp/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)](https://github.com/isAlexYoung/cmcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)
[![Downloads](https://img.shields.io/github/downloads/isAlexYoung/cmcp/total)](https://github.com/isAlexYoung/cmcp/releases/latest)

English | [中文](README_ZH.md) | [Changelog](https://github.com/isAlexYoung/cmcp/releases)

**[Download](#download) · [Quick Start](#quick-start) · [Features](#features) · [FAQ](#faq) · [License](#license)**

</div>

## Download

Get the latest version from [Releases](https://github.com/isAlexYoung/cmcp/releases/latest). Each package has a matching `.sha256` file.

| Platform | Package |
|---|---|
| Windows x64 | `CMCP-<version>-windows-x64.zip` |
| macOS, Apple silicon | `CMCP-<version>-macos-arm64.zip` |
| macOS, Intel | `CMCP-<version>-macos-x64.zip` |

## Quick Start

You need a cloud PC that is reachable at an HTTPS address and has Claude installed.

**Windows**

1. Extract the whole zip to a folder. Do not run it from inside the archive.
2. Run `CMCP.exe`.
3. Click **Add cloud PC** and enter its address.
4. Start the connection and sign in to the cloud PC when asked.
5. After adding a new cloud PC, fully quit and reopen Claude on it.

Claude on the cloud PC can now use the tools on this computer.

**macOS**

1. Unzip the package and open `CMCP.app`. The manager opens in your browser.
2. Follow steps 3 to 5 above.

The app is ad-hoc signed rather than notarized, so macOS may ask you to confirm before it opens the first time.

## Features

- **Independent connections**: start and stop each cloud PC on its own.
- **Card-based interface**: custom names and icons, drag to reorder, collapsible details.
- **Connection recovery**: reconnection, request waiting, result lookup and de-duplication after a dropped connection.
- **Easy sign-in**: share a browser sign-in, or save the password encrypted and sign in automatically.
- **Personalization**: light and dark themes, English and Simplified Chinese.
- **Desktop integration**: system tray, start with Windows, desktop shortcut and in-app updates.

## FAQ

**CMCP says the portable package is incomplete. What should I do?**

Some files were not extracted. Extract the whole zip again to a new folder and run `CMCP.exe` from there.

**Claude on the cloud PC does not show the tools.**

Fully quit and reopen Claude on the cloud PC. A newly added configuration is only loaded when Claude starts.

**What happens when I close the window?**

It depends on **Settings → When closing the window**. Exiting disconnects every cloud PC; hiding to the system tray keeps connected cloud PCs running.

**How do I update?**

Open **Settings → Check for updates**. CMCP downloads and verifies the update for you.

**Where are the logs?**

Open **Settings → Log folder**. On Windows, errors are written to `user\error.log` in the program folder.

**Is CMCP an Anthropic product?**

No. CMCP is an independent tool with no official affiliation with Anthropic.

## License

[MIT](../LICENSE). Bundled third-party components keep their own licenses; see [third-party notices](../THIRD_PARTY_NOTICES.txt).
