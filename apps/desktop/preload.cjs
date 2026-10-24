"use strict";

// Sandboxed preload. It must stay plain CommonJS (a sandboxed
// preload cannot be ESM) and may use only the small module surface
// Electron gives sandboxed preloads. It exposes exactly one thing
// to the page: a frozen { appVersion } bridge, so the UI can show
// which desktop build it is running inside. No IPC, no Node, no
// Electron objects cross the bridge.
const { contextBridge } = require("electron");

const VERSION_ARG = "--kavvo-app-version=";
const versionArg = process.argv.find((arg) => arg.startsWith(VERSION_ARG));
const appVersion = versionArg
  ? versionArg.slice(VERSION_ARG.length)
  : "unknown";

contextBridge.exposeInMainWorld(
  "kavvoDesktop",
  Object.freeze({ appVersion }),
);
