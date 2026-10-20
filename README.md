# ColossusX Node Manager

## 1. Download and install

Sign in to GitHub, download your ZIP, and extract it. No cloning is required. These downloads expire on November 3, 2026.

| OS                  | Download                                                                                                 | Install                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Windows x64         | [Windows ZIP](https://github.com/CypherTroopers/node-app/actions/runs/39420949839/artifacts/12263693137) | Extract the ZIP.                               |
| Mac — Apple silicon | [Mac ZIP](https://github.com/CypherTroopers/node-app/actions/runs/39420949839/artifacts/12262429443)     | Open the DMG and drag the app to Applications. |
| Linux x64           | [Linux ZIP](https://github.com/CypherTroopers/node-app/actions/runs/39420949839/artifacts/12263134727)   | Extract the ZIP.                               |

## 2. Run

Windows — open PowerShell in the extracted folder:

```powershell
.\ColossusX-Node-Manager-0.1.0-win-x64.exe
```

Mac:

```sh
open -a "ColossusX Node Manager"
```

Linux — open a terminal in the extracted folder:

```sh
chmod +x ./ColossusX-Node-Manager-0.1.0-linux-x86_64.AppImage
APPIMAGE_EXTRACT_AND_RUN=1 ./ColossusX-Node-Manager-0.1.0-linux-x86_64.AppImage
```

## 3. View the UI

The app window opens automatically with six tabs. Choose **Prepare node**, wait for **Ready**, then open **Node → Start node**. Keep the app open while the node is running.
