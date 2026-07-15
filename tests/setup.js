"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
function cleanAndInitDataDir() {
    if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
        try {
            (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
        }
        catch {
            return;
        }
    }
    try {
        (0, node_fs_1.mkdirSync)(DATA_ROOT, { recursive: true, mode: 0o700 });
    }
    catch {
        return;
    }
}
beforeAll(() => {
    cleanAndInitDataDir();
});
afterAll(() => {
    if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
        (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
    }
});
