import { formatBytes } from "./bytes.ts"
import { DEPLOY_SITE } from "./constants.ts"

interface SummaryInfo {
  org: string
  project: string
  version: string
  sha256: string
  manifestSha256: string
  sizeBytes: number
  fileCount: number
  url: string
  registryUrl: string
  dryRun: boolean
  skipped: boolean
  files: string[]
  excluded: string[]
  excludedCount: number
  overRecommended: boolean
}

const LIST_CAP = 200

function escapeMd(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
}

function listBlock(title: string, paths: string[], total: number): string {
  const shown = paths.slice(0, LIST_CAP)
  const lines = [`### ${title}`, ""]
  if (shown.length === 0) {
    lines.push("None.")
  } else {
    for (const path of shown) lines.push(`- \`${escapeMd(path)}\``)
  }
  if (total > shown.length) {
    lines.push("", `And ${total - shown.length} more.`)
  }
  return lines.join("\n")
}

export function renderSummary(info: SummaryInfo): string {
  const result = info.dryRun
    ? "Dry run. Nothing was uploaded."
    : info.skipped
      ? "Skipped. This version is already published with the same digests."
      : "Published."
  const lines = [
    "## alchemy.new publish",
    "",
    "| | |",
    "| --- | --- |",
    `| Package | \`${escapeMd(info.org)}/${escapeMd(info.project)}\` |`,
    `| Version | \`${escapeMd(info.version)}\` |`,
    `| Size | ${formatBytes(info.sizeBytes)} (${info.sizeBytes} bytes) |`,
    `| sha256 | \`${info.sha256}\` |`,
    `| Manifest sha256 | \`${info.manifestSha256}\` |`,
    `| Manifest | Uploaded separately. \`alchemy.new.jsonc\` is not in the archive. |`,
    `| Files | ${info.fileCount} |`,
    `| Result | ${result} |`,
    `| Deploy URL | ${info.url} |`,
    `| Registry | ${info.registryUrl} |`,
  ]
  if (info.overRecommended) {
    lines.push(
      `| Warning | Archive is above the 80 MiB publisher target. The hard cap is 256 MiB. |`,
    )
  }
  lines.push(
    "",
    listBlock("Packed files", info.files, info.fileCount),
    "",
    listBlock("Excluded", info.excluded, info.excludedCount),
    "",
  )
  return lines.join("\n")
}

export function deployUrl(org: string, project: string, version: string): string {
  return `${DEPLOY_SITE}/?package=${encodeURIComponent(org)}/${encodeURIComponent(project)}&version=${encodeURIComponent(version)}`
}
