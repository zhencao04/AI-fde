import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = join(process.cwd(), ".data");

function cleanAndInitDataDir(): void {
  if (existsSync(DATA_ROOT)) {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      return;
    }
  }
  try {
    mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
}

beforeAll(() => {
  cleanAndInitDataDir();
});

afterAll(() => {
  if (existsSync(DATA_ROOT)) {
    rmSync(DATA_ROOT, { recursive: true, force: true });
  }
});
