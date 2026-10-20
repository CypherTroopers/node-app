const { createRequire } = require("node:module");
const path = require("node:path");
const { Arch } = require("electron-builder");

module.exports = (context) => {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const supported = { win32: "x64", darwin: "arm64", linux: "x64" };
  if (supported[platform] !== arch) {
    throw new Error("Build Windows x64, macOS ARM64, or Linux x64 only.");
  }
  // PTY optional dependencies are installed for the build host. Cross builds can
  // otherwise silently omit the native Windows console dependency.
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`Build ${platform}-${arch} on a matching native OS and architecture.`);
  }
  const appRequire = createRequire(path.join(context.packager.projectDir, "package.json"));
  const ptyRequire = createRequire(appRequire.resolve("@lydell/node-pty"));
  ptyRequire.resolve(`@lydell/node-pty-${platform}-${arch}`);
};
