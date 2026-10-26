// .vscode/settings.json sets js/ts.tsdk.path to .vscode/tsrs. The editor
// expects tsgo in that directory. The link stays untracked: a committed
// symlink to node_modules dangles in an action checkout and the runner
// stops while copying the action.
import { lstatSync, mkdirSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const linkPath = join(root, ".vscode", "tsrs", "tsgo")
const tsrsBin = join(root, "node_modules", "tsrs", "bin", "tsrs")
const target = "../../node_modules/tsrs/bin/tsrs"

function exists(path) {
  try {
    lstatSync(path)

    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

// A missing tsrs binary (for example a production install) and a link that
// is already present are both success. This script must not fail nub install.
if (exists(tsrsBin) && !exists(linkPath)) {
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, "file")
}
