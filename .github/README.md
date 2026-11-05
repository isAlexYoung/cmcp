<div align="center">

<img src="../app/assets/cmcp-icon-1024.png" alt="CMCP icon" width="128" height="128" />

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
| Windows x64, guided installer (recommended) | `CMCP-<version>-windows-x64-setup.exe` |
| Windows x64, portable | `CMCP-<version>-windows-x64.zip` |
| macOS, Apple silicon | `CMCP-<version>-macos-arm64.dmg` |
| macOS, Intel | `CMCP-<version>-macos-x64.dmg` |

The macOS `.zip` files with the same names are for in-app updates. To install, download the `.dmg`.

## Quick Start

You need a cloud PC that is reachable at an HTTPS address and has Claude installed.

**Windows**

1. Run the installer and choose the install folder, shortcuts and whether to start at sign-in. It does not need administrator rights. The installer is not code-signed yet, so if Windows says it protected your PC, click **More info → Run anyway**. For the portable version, extract the whole zip to a folder and run `CMCP.exe`.
2. Open CMCP.
3. Click **Add device** and enter its address.
4. Start the connection and sign in to the cloud PC when asked.
5. After adding a new cloud PC, fully quit and reopen Claude on it.

Claude on the cloud PC can now use the tools on this computer.

**macOS**

1. Open the `.dmg` and drag `CMCP.app` to the Applications folder.
2. Open CMCP from Applications, then follow steps 3 to 5 above.

The app is ad-hoc signed rather than notarized, so macOS blocks it the first time you open it. Allow it once, depending on your macOS version:

- **macOS 15 and later**: click **Done** in the message, open **System Settings → Privacy & Security**, find CMCP near the bottom of the page, click **Open Anyway** and confirm.
- **macOS 13 and 14**: in Applications, Control-click CMCP, choose **Open**, then click **Open** in the message.
- **If macOS says the app is damaged**: this comes from the download quarantine flag. After checking the package against its `.sha256` file, run this in Terminal and open CMCP again:

```bash
xattr -dr com.apple.quarantine /Applications/CMCP.app
```

## Features

- **Independent connections**: start and stop each cloud PC on its own.
- **Card-based interface**: custom names and icons, drag to reorder, collapsible details.
- **Connection recovery**: reconnection, request waiting, result lookup and de-duplication after a dropped connection.
- **Easy sign-in**: share a browser sign-in, or save the password encrypted and sign in automatically.
- **SSH sign-in**: open your chosen terminal connected to a VPS with one click, using a password or a key. A device can have SSH, shared web sign-in or both. SSH opens a terminal only; it does not carry the MCP connection.
- **Personalization**: light and dark themes, English and Simplified Chinese.
- **Desktop integration**: system tray (menu bar on macOS), start at login, desktop shortcut and in-app updates.

## FAQ

**CMCP says the portable package is incomplete. What should I do?**

Some files were not extracted. Extract the whole zip again to a new folder and run `CMCP.exe` from there.

**Claude on the cloud PC does not show the tools.**

Fully quit and reopen Claude on the cloud PC. A newly added configuration is only loaded when Claude starts.

**What happens when I close the window?**

It depends on **Settings → General → Minimize to tray on close** (**Minimize to menu bar on close** on macOS). When on, connected devices stay connected. When off, closing the window exits and disconnects every cloud PC.

**How do I update?**

Open **Settings → About → Check for updates**. CMCP downloads and verifies the update for you. On macOS, if the new version fails to start, CMCP returns to the previous version automatically. Updating needs permission to change the folder CMCP is in, so update from an administrator account when it is in Applications. Because the app is ad-hoc signed, macOS may ask you to grant permissions such as Accessibility again after an update.

**How do I uninstall?**

On Windows, open **Settings → About → Uninstall CMCP**. If you used the guided installer, you can also uninstall from Installed apps in Windows Settings. It disconnects everything, removes the Claude configuration from cloud PCs where it can, and deletes saved addresses, passwords and settings. The installed version also removes its program files and shortcuts. For the portable version, delete the program folder and desktop shortcut yourself afterwards.

On macOS, open **Settings → About → Uninstall CMCP**. It also disconnects everything and removes the Claude configuration from cloud PCs where it can, then deletes the app, the data in `~/Library/Application Support/CMCP`, passwords saved in Keychain and the login item. It cannot remove the configuration from a cloud PC that is not connected and has no saved password, and it tells you how many were missed. If you already dragged the app to the Trash, run this command to delete the data, then delete the items named `CMCP Mac cloud password` in Keychain Access:

```bash
rm -rf ~/Library/Application\ Support/CMCP
```

**Where are the logs?**

Open **Settings → About → Log folder**. On Windows, errors are written to `user\error.log` in the program folder. On macOS, logs and settings are in `~/Library/Application Support/CMCP`.

**Is CMCP an Anthropic product?**

No. CMCP is an independent tool with no official affiliation with Anthropic.

## License

The code is released under the [MIT License](../LICENSE). Bundled third-party components keep their own licenses; see [third-party notices](../THIRD_PARTY_NOTICES.txt).

### App icon

The CMCP icon is original artwork created for this project. It is © 2026 CMCP, all rights reserved, and is **not** covered by the MIT License.

You may use it only to refer to CMCP and as part of unmodified CMCP packages. Without written permission, you may not use it commercially, modify it, or use it for another product or service. Forks and derivative products must replace it. See the [full notice](../THIRD_PARTY_NOTICES.txt).
