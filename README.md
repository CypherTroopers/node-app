# ColossusX Node Manager

## 1. Download and install

Download the app for your OS. No GitHub account or cloning is required. [Release page](https://github.com/CypherTroopers/node-app/releases/latest).

| OS                  | Download                                                                                                                                 | Install                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Windows x64         | [Windows EXE](https://github.com/CypherTroopers/node-app/releases/download/v0.1.2/ColossusX-Node-Manager-0.1.2-win-x64.exe)              | Save the downloaded file.                      |
| Mac — Apple silicon | [Mac DMG](https://github.com/CypherTroopers/node-app/releases/download/v0.1.2/ColossusX-Node-Manager-0.1.2-mac-arm64.dmg)                | Open the DMG and drag the app to Applications. |
| Linux x64           | [Linux AppImage](https://github.com/CypherTroopers/node-app/releases/download/v0.1.2/ColossusX-Node-Manager-0.1.2-linux-x86_64.AppImage) | Save the downloaded file.                      |

## 2. Run

Windows — open PowerShell in the download folder:

```powershell
.\ColossusX-Node-Manager-0.1.2-win-x64.exe
```

Mac:

```sh
open "/Applications/colossusx-node-manager.app"
```

The Mac app uses ad-hoc signing and is not notarized. If macOS blocks the first launch and **Open Anyway** is available, choose **System Settings → Privacy & Security → Open Anyway**, then confirm **Open**. [Apple instructions](https://support.apple.com/en-us/102445).

Linux — open a terminal in the download folder:

```sh
chmod +x ./ColossusX-Node-Manager-0.1.2-linux-x86_64.AppImage
APPIMAGE_EXTRACT_AND_RUN=1 ./ColossusX-Node-Manager-0.1.2-linux-x86_64.AppImage
```

## 3. View the UI

The app window opens automatically with six tabs. Choose **Prepare node**, wait for **Ready**, then open **Node → Start node**. Keep the app open while the node is running.

After updating, stop the node and choose **Prepare node** once to refresh its launch files, then choose **Start node**. Verified cached binaries are reused.
